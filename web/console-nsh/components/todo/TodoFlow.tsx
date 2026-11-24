// Flow: the jobs and the links between them ("job B uses job A's result") as a graph read from
// left to right, for chains that are more than a tree. The third view of the jobs page, beside the
// list and the calendar. It holds view state only (the selection, link mode, the open picker, how
// far a replay has travelled); every change to the data goes out through a callback.
//
// The picture is laid out by flow-layout.ts (pure, once per change of the jobs): a job is never
// moved by hand, nothing of the picture is saved.
//
// A link is drawn as in a diagram editor: every job has a port in the middle of its right edge
// (it shows under the pointer, and on the selected job), and dragging from it to another job makes
// that job use this one. While the pointer travels, a line follows it from the port, the jobs that
// may take the link are outlined and the one under the pointer is lit; letting go anywhere else
// makes nothing. A press on the port, without a drag, is the older way: it starts link mode, and
// the next job pressed takes the link (the keyboard's way too). nsh has no DOM drag and drop, so
// the port is a `PanResponder`; nothing is mounted or unmounted while it holds the gesture (that
// ends a gesture in nsh), so the line's canvas and the hint are there from the start. On a phone the picture is the same, left to right with narrower jobs, and nothing can be edited.
//
// How it is drawn (nsh has no SVG):
// - a job is a view at its place in the layout; when the layout changes it takes its new place at
//   once and glides there by `transform` from where it stood (FLIP), so its frame is always the
//   real one for presses, scrolling and screen readers;
// - a link is a Canvas of its own, as large as its route: the line (solid: each new result, dashed:
//   a fresh result, dotted: the latest result), and over it the pulse, one dash whose offset an
//   animated value drives, so it travels along the route's turns natively, with no JS per frame;
// - links never change shape while shown: when the layout changes they go out, the jobs glide, and
//   the links are made again and draw in from the job they leave (a clip that opens along the
//   columns' direction, which every route follows);
// - one animated value is the clock of all live pulses, another of a whole replay: each link's
//   pulse and each job's border light are read off it at their own times, so they stay in step;
// - a canvas has no parts to press or name: each link has a small view on its last run, before the
//   job it enters, which is its name for screen readers and the trigger of its picker (the app's
//   DropdownMenu).
//
// Craft:
// - a job's marker is its own state (on: filled, off: hollow, running: the turning ring) and no
//   word repeats it; a replay changes it only where the run failed;
// - straight runs are drawn on whole points plus a half, the pixels a job's 1pt border is drawn on;
// - opacity and transform are all that animate; reduced motion zeroes every duration (no entrance,
//   no glide, no draw-in, no pulse: a replay shows where the chain ended at once).
import type { AnimatedNode, AnimatedValue, JSX, ViewRef } from "nsh";
import { batch, Canvas, cleanup, computed, createAnimatedValue, Easing, effect, PanResponder, Path2D, reduceMotion, Scroll, signal, Text, token, untracked, View } from "nsh";
import { translate } from "../../lib/core/context.js";
import { gutterX, gutterY } from "../frame/metrics";
import { FadeText, SCROLLBAR } from "../motion";
import { withAlpha } from "../motion/color";
import { easeProgress, MOTION_EASE, MOTION_EASE_CSS, MOTION_NORMAL, motionMs } from "../motion/tokens";
import { createPartProbe, type PartLayoutListener } from "../shared/partProbe";
import { bindPaneEscape, Button, DropdownMenu, Icon, type MenuEntry, StatusMark, type StatusState, Tip, TipButton } from "../ui";
import {
  canUse,
  downstreamOf,
  FLOW_DESKTOP,
  FLOW_PHONE,
  flowGraph,
  layoutFlow,
  upstreamOf,
  type FlowLink,
  type FlowNode,
} from "./flow-layout";

const t = translate as (key: string, vars?: Record<string, unknown> | null) => string;

// For tests. Headless runs draw nothing and a step of a test ends only once the app is quiet, so
// a test can check geometry and what happened on the way, not the look:
// - `layout`: where the parts lie on the page (`canvas`, `job-<id>`, `line-<used>><job>` a link's
//   drawing, `link-<used>><job>` its picker's target), as they are laid out;
// - `events`: `links:out` and `links:in` as the links go while the jobs glide and are drawn again,
//   and `step:<column>:<job>+<job>…` (the jobs reached so far) as a replay travels.
let probeListener: PartLayoutListener | null = null;
let eventListener: ((event: string) => void) | null = null;
/** Hears the frames and events of the Flow views made from now on; `null` stops it. */
export function probeTodoFlow(layout: PartLayoutListener | null, events: ((event: string) => void) | null = null) {
  probeListener = layout;
  eventListener = events;
}
const parts = createPartProbe(() => probeListener ?? undefined);

export interface FlowJob {
  id: string;
  title: string;
  /** One line under the title: when it runs, or where it reports. Already localised. */
  note: string;
  enabled: boolean;
  running: boolean;
  uses: { job_id: string }[];
  join: "all" | "any";
}
/** One job's part in a finished chain of runs, in the order they happened. */
export interface FlowRunStep {
  job_id: string;
  status: "done" | "failed" | "skipped" | "canceled";
  note: string;
}
export interface TodoFlowProps {
  jobs: FlowJob[];
  /** The chain to replay; null or absent shows the live state. */
  replay?: FlowRunStep[] | null;
  /** Phone layout: read-only, the same left to right with narrower jobs. */
  mobile?: boolean;
  /** A save is under way: no edits. */
  busy?: boolean;
  onOpenJob?: (id: string) => void;
  onAddUse?: (jobId: string, usedJobId: string) => void;
  onRemoveUse?: (jobId: string, usedJobId: string) => void;
  onSetJoin?: (jobId: string, join: "all" | "any") => void;
}

/* ---------- timings (the prototype's) ---------- */

/** Jobs glide to a new layout; the links wait this long, then draw again. */
const GLIDE_MS = 360;
const SETTLE_MS = 380;
/** The entrance: a job rises 6pt and fades in, a column after the other. */
const RISE_MS = 320;
const RISE_STEP_MS = 70;
/** A link draws in, a column after the other; at the first entrance, once the jobs are there. */
const DRAW_MS = 500;
const DRAW_STEP_MS = 110;
const DRAW_AFTER_ENTRANCE_MS = 380;
const BOOT_MS = 1200;
/** A replay travels a column at a time. */
const STEP_MS = 620;
/** The pulse: a 12pt dash at 351pt a second (632pt in 1.8s), round and round while live. */
const PULSE = 12;
const PULSE_SPEED = 632 / 1.8;
const LIVE_PERIOD_MS = 1800;
/** A border lights as the pulse arrives: once in a replay (0.9s), on every pass while live. */
const LIT_MS = 900;
/** Fades: a job's 180ms, a link's 240ms. */
const LINK_FADE_MS = 240;
/** How long a link just asked for may take to arrive and still open its picker. */
const PENDING_PICKER_MS = 4000;
/** The room round the picture inside the canvas: a border light's halo, the link button on a job's edge. */
const INSET = 14;
/** How far a press on a port moves before it is a drag, in points. */
const LINK_DRAG_SLOP = 4;
/** Under the last row: its join rule. */
const FOOT = 28;

const DRAW_EASE = Easing.bezier(0.3, 0.7, 0.2, 1);
const GLIDE_EASE = Easing.bezier(...MOTION_EASE);

/* ---------- what each part shows ---------- */

type Lit = { kind: "live"; at: number; period: number } | { kind: "replay"; at: number } | null;

interface JobLook {
  job: FlowJob;
  /** Out of the picture for now: off the selected line, not a target in link mode, not reached by the replay. */
  faded: boolean;
  /** The fade waits for the pulse (a job the replay reaches at this step). */
  wait: number;
  selected: boolean;
  /** The job a new link is being drawn from. */
  linking: boolean;
  /** May be chosen as the job that uses the linking one. */
  target: boolean;
  /** A link is being dragged over it, and it may take it. */
  over: boolean;
  /** Its port may start a drag now. */
  canDrag: boolean;
  /** Takes presses: to select it, or as a target. */
  pressable: boolean;
  mark: StatusState;
  note: string;
  failed: boolean;
  /** Reached by the replay: its border is the run's colour. */
  reached: boolean;
  lit: Lit;
  /** The link button and the open button show. */
  canLink: boolean;
  canOpen: boolean;
  /** Its join rule shows; `joinEdits`: and can be switched. */
  join: boolean;
  joinEdits: boolean;
  name: string;
}

interface LinkLook {
  /** `rest`, `ink` (on the selected line, or travelled by the replay) or `danger` (out of a job that failed). */
  tone: "rest" | "ink" | "danger" | "dim";
  faded: boolean;
  pulse: { kind: "live"; period: number } | { kind: "replay"; start: number; duration: number } | null;
  name: string;
  /** Its picker opens. */
  edits: boolean;
}

/* ---------- a job ---------- */

function FlowJobBox(props: {
  node: () => FlowNode;
  look: () => JobLook;
  /** The entrance's delay when the job is made. */
  enterDelay: () => number;
  live: AnimatedValue;
  clock: AnimatedValue;
  onPress: () => void;
  onOpen: () => void;
  onLink: () => void;
  onJoin: () => void;
  /** A drag from its port: where the pointer is on the page as it starts, moves and is let go; `cancel` when the system takes it. */
  onLinkDrag: (phase: "start" | "move" | "drop" | "cancel", page?: { x: number; y: number }) => void;
}) {
  const still = untracked(reduceMotion);
  const id = untracked(() => props.node().id);
  // The port's drag: taken once a press on it has moved a few points, so a click stays a press.
  const pan = PanResponder.create({
    onMoveShouldSetPanResponder: (_event, gesture) => untracked(() => props.look().canDrag) && Math.hypot(gesture.dx, gesture.dy) >= LINK_DRAG_SLOP,
    onPanResponderGrant: (event) => props.onLinkDrag("start", { x: event.pageX, y: event.pageY }),
    onPanResponderMove: (event) => props.onLinkDrag("move", { x: event.pageX, y: event.pageY }),
    onPanResponderRelease: (event) => props.onLinkDrag("drop", { x: event.pageX, y: event.pageY }),
    onPanResponderTerminate: () => props.onLinkDrag("cancel"),
    // The picture's scroll views do not take a link away mid-drag.
    onPanResponderTerminationRequest: () => false,
  }).panHandlers;
  // The entrance: 0 below and clear, 1 in place.
  const enter = createAnimatedValue(still ? 1 : 0);
  if (!still) void enter.timing(1, { duration: RISE_MS, delay: untracked(props.enterDelay), easing: Easing.ease });
  // The glide (FLIP): the frame is the new place at once; these carry it from the old one.
  const dx = createAnimatedValue(0);
  const dy = createAnimatedValue(0);
  let box: ViewRef | undefined;
  let last: { x: number; y: number } | null = null;
  let glide: { ox: number; oy: number; start: number; duration: number } | null = null;
  effect(() => {
    const { x, y } = props.node();
    untracked(() => {
      if (last && (last.x !== x || last.y !== y)) {
        const duration = motionMs(GLIDE_MS);
        let ox = last.x - x;
        let oy = last.y - y;
        const now = performance.now();
        if (glide) {
          // Mid-glide: start from where it is drawn now.
          const left = 1 - easeProgress(Math.max(0, (now - glide.start) / glide.duration));
          ox += glide.ox * left;
          oy += glide.oy * left;
        }
        if (duration > 0) {
          glide = { ox, oy, start: now, duration };
          dx.set(ox);
          dy.set(oy);
          void dx.timing(0, { duration, easing: GLIDE_EASE });
          void dy.timing(0, { duration, easing: GLIDE_EASE });
        } else {
          glide = null;
          dx.set(0);
          dy.set(0);
        }
      }
      // A job that moved is somewhere else on the page, though its frame in its own view is the same.
      if (last && probeListener) parts.report(`job-${id}`, box);
      last = { x, y };
    });
  });
  cleanup(() => {
    for (const value of [enter, dx, dy]) void value.stop();
  });

  // The border light, read off the clock the pulses run on. Keyed by what it depends on, so a
  // change elsewhere in the look builds no new animated nodes.
  const litKey = computed(() => {
    const lit = props.look().lit;
    return lit ? (lit.kind === "live" ? `live:${lit.at}:${lit.period}` : `replay:${lit.at}`) : "";
  });
  const light = computed((): number | AnimatedNode => {
    const lit = litKey() ? untracked(() => props.look().lit) : null;
    if (!lit) return 0;
    if (lit.kind === "live") {
      // Up in 4% of the prototype's 1.8s lap and gone by 36%, each time the pulse gets here.
      const lap = LIVE_PERIOD_MS / lit.period;
      return props.live.sub(lit.at).mod(1).interpolate({ inputRange: [0, 0.04 * lap, 0.36 * lap, 1], outputRange: [0, 1, 0, 0] });
    }
    return props.clock.interpolate({ inputRange: [lit.at, lit.at + 0.12 * LIT_MS, lit.at + LIT_MS], outputRange: [0, 1, 0] });
  });
  // The mark pops as the replay's pulse arrives (0.3 → 1.5 → 1 in 420ms).
  const pop = computed((): number | AnimatedNode => {
    const key = litKey();
    if (!key.startsWith("replay:")) return 1;
    const at = Number(key.slice(7));
    return props.clock.interpolate({ inputRange: [at - 1, at, at + 252, at + 420], outputRange: [1, 0.3, 1.5, 1] });
  });

  const blue = () => String(token("blue"));
  const danger = () => String(token("danger"));
  const border = () => {
    const look = props.look();
    if (look.over || look.target) return blue();
    if (look.reached) return withAlpha(look.failed ? danger() : blue(), 0.7);
    if (look.selected || look.linking) return withAlpha(blue(), 0.7);
    return String(token("line-soft"));
  };
  const width = () => props.node().w;
  const height = () => props.node().h;
  const fade = () => motionMs(MOTION_NORMAL);
  return (
    <View
      // `group`: its port shows while the pointer is over the job.
      class="group absolute"
      style={{
        left: props.node().x,
        top: props.node().y,
        width: width(),
        opacity: enter,
        transform: [{ translateX: dx }, { translateY: dy.add(enter.interpolate({ inputRange: [0, 1], outputRange: [6, 0] })) }],
      }}
    >
      <View
        style={{
          opacity: props.look().faded ? 0.32 : 1,
          transitionProperty: "opacity",
          transitionDuration: fade(),
          transitionDelay: props.look().wait,
          transitionTimingFunction: "ease",
        }}
        testID={`todo-flow-node-${id}`}
      >
        <View
          role="button"
          focusable={props.look().pressable}
          disabled={!props.look().pressable}
          onPress={() => props.onPress()}
          accessibilityLabel={props.look().name}
          accessibilityState={{ selected: props.look().selected }}
          testID={`todo-flow-job-${id}`}
          ref={(view: ViewRef) => {
            box = view;
          }}
          onLayout={probeListener ? () => parts.report(`job-${id}`, box) : undefined}
          class={`flex-row items-center gap-2.5 rounded-[10px] border pl-3 ${props.look().target ? "border-dashed" : ""}`}
          style={{
            height: height(),
            // Room for the open button while it shows.
            paddingRight: props.look().canOpen ? 40 : 12,
            backgroundColor: String(token(props.look().selected || props.look().over ? "dialog" : "card")),
            borderColor: border(),
            transitionProperty: "colors",
            transitionDuration: fade(),
            transitionDelay: props.look().wait,
            transitionTimingFunction: "ease",
          }}
          hoverStyle={{ borderColor: String(token("ring")) }}
          focusVisibleStyle={{ outlineWidth: 1.5, outlineColor: String(token("ring")), outlineOffset: 2, outlineStyle: "solid" }}
        >
          <View class="w-2.5 items-center" accessibilityElementsHidden style={{ transform: [{ scale: pop() }] }}>
            <StatusMark state={props.look().mark} size={7} corner={2} />
          </View>
          <View class="min-w-0 flex-1">
            <FadeText
              text={props.look().job.title}
              class={`text-[15px] leading-[20px] tracking-[-0.2px] ${props.look().job.enabled || props.look().reached ? "text-foreground" : "text-muted-foreground"}`}
            />
            <FadeText text={props.look().note} class={`text-xs leading-[16.2px] ${props.look().failed ? "text-danger" : "text-muted-foreground"}`} />
          </View>
        </View>
        {/* The border light: over the job's own border, with a soft halo. */}
        <View
          accessibilityElementsHidden
          class="absolute left-0 top-0 rounded-[10px] border"
          style={{
            width: width(),
            height: height(),
            borderColor: props.look().failed ? danger() : blue(),
            boxShadow: `0 0 0 3px ${withAlpha(props.look().failed ? danger() : blue(), 0.16)}`,
            opacity: light(),
            pointerEvents: "none",
          }}
        />
        <If when={props.look().canOpen}>
          <View class="absolute" style={{ left: width() - 36, top: (height() - 24) / 2 }}>
            <Button
              size="xxs"
              variant="plain"
              icon="PhCaretRight"
              label={t("todo_flow_open", { job: props.look().job.title })}
              testID={`todo-flow-open-${id}`}
              onPress={() => props.onOpen()}
            />
          </View>
        </If>
        <If when={props.look().canLink}>
          {/* The port, where its links leave: the middle of its right edge. It is on every job
              that can start a link, shown under the pointer and on the selected job; a drag from
              it draws the link, a press starts link mode. */}
          <View
            {...pan}
            class={`absolute transition-opacity duration-150 ${props.look().selected || props.look().linking ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"}`}
            style={{ left: width() - 11, top: (height() - 22) / 2 }}
            testID={`todo-flow-port-${id}`}
          >
            <TipButton
              onPress={() => props.onLink()}
              accessibilityLabel={props.look().linking ? t("todo_flow_link_cancel") : t("todo_flow_link_add", { job: props.look().job.title })}
              selected={props.look().linking}
              tooltip={<Tip text={props.look().linking ? t("todo_flow_link_cancel") : t("todo_flow_link_add", { job: props.look().job.title })} />}
              hitSlop={5}
              testID={`todo-flow-link-from-${id}`}
              class={`size-[22px] items-center justify-center rounded-full border border-blue ${props.look().linking ? "bg-blue" : "bg-card hover:bg-dialog"}`}
            >
              <Icon name="PhPlus" size={10} color={props.look().linking ? "on-accent" : "blue"} />
            </TipButton>
          </View>
        </If>
        <If when={props.look().join}>
          <View class="flex-row" style={{ marginTop: 5, marginLeft: 6 }}>
            <If
              when={props.look().joinEdits}
              else={
                <Text class="px-1.5 py-px text-xs leading-[16.2px] text-primary" testID={`todo-flow-join-${id}`}>
                  {t(props.look().job.join === "any" ? "todo_flow_join_any" : "todo_flow_join_all")}
                </Text>
              }
            >
              <View
                role="button"
                focusable
                onPress={() => props.onJoin()}
                accessibilityLabel={`${props.look().job.title} ${t(props.look().job.join === "any" ? "todo_flow_join_any" : "todo_flow_join_all")}`}
                accessibilityHint={t("todo_flow_join_hint")}
                testID={`todo-flow-join-${id}`}
                class="rounded-[4px] px-1.5 py-px hover:bg-hover focus-visible:bg-hover"
                style={{ transitionProperty: "colors", transitionDuration: fade() }}
              >
                <Text class="text-xs leading-[16.2px] text-primary">{t(props.look().job.join === "any" ? "todo_flow_join_any" : "todo_flow_join_all")}</Text>
              </View>
            </If>
          </View>
        </If>
      </View>
    </View>
  );
}

/* ---------- a link ---------- */

function FlowLinkLine(props: {
  link: () => FlowLink;
  look: () => LinkLook;
  /** The draw-in's delay when the link is made. */
  drawDelay: () => number;
  live: AnimatedValue;
  clock: AnimatedValue;
}) {
  const still = untracked(reduceMotion);
  const key = untracked(() => props.link().key);
  // The draw-in: 0 nothing, 1 the whole line.
  const reveal = createAnimatedValue(still ? 1 : 0);
  let landed: ReturnType<typeof setTimeout> | undefined;
  if (!still) {
    const delay = untracked(props.drawDelay);
    void reveal.timing(1, { duration: DRAW_MS, delay, easing: DRAW_EASE });
    // A page that gets no frames (a hidden tab) steps animated values only at their ends: land it.
    landed = setTimeout(() => reveal.set(1), delay + DRAW_MS + 80);
  }
  // The line's colour eases from the last one to the next (180ms).
  const tint = createAnimatedValue(1);
  const colorOf = (tone: LinkLook["tone"]) =>
    tone === "ink"
      ? String(token("blue"))
      : tone === "danger"
        ? String(token("danger"))
        : withAlpha(String(token("muted-foreground")), tone === "dim" ? 0.5 : 0.6);
  const colors = signal<[string, string]>(untracked(() => [colorOf(props.look().tone), colorOf(props.look().tone)]));
  effect(() => {
    const next = colorOf(props.look().tone);
    untracked(() => {
      const [, shown] = colors();
      if (shown === next) return;
      colors.set([shown, next]);
      const duration = motionMs(MOTION_NORMAL);
      if (!duration) return tint.set(1);
      tint.set(0);
      void tint.timing(1, { duration, easing: Easing.ease });
    });
  });
  cleanup(() => {
    if (landed) clearTimeout(landed);
    for (const value of [reveal, tint]) void value.stop();
  });
  const pulseKey = () => {
    const pulse = props.look().pulse;
    return pulse ? pulse.kind : "none";
  };
  return (
    <Canvas
      accessibilityElementsHidden
      // What a test can read of a drawing: its tone, and whether a pulse runs on it.
      testID={`todo-flow-line-${key}.${props.look().tone}.${pulseKey()}`}
      {...parts.probe(() => `line-${key}`)}
      class="absolute"
      style={{
        left: props.link().box.x,
        top: props.link().box.y,
        width: props.link().box.w,
        height: props.link().box.h,
        opacity: props.look().faded ? 0.25 : 1,
        transitionProperty: "opacity",
        transitionDuration: motionMs(LINK_FADE_MS),
        transitionTimingFunction: "ease",
        pointerEvents: "none",
      }}
      draw={(cx, size) => {
        const link = props.link();
        const look = props.look();
        const [from, to] = colors();
        const path = new Path2D(link.d);
        // Whole points plus a half: a 1pt line on the pixels a 1pt border is drawn on.
        cx.translate(0.5, 0.5);
        cx.lineCap = "round";
        cx.lineJoin = "round";
        cx.save();
        // The draw-in: a clip that opens from the job the link leaves.
        cx.beginPath();
        cx.rect(-1, -1, reveal.interpolate({ inputRange: [0, 1], outputRange: [0, size.width + 2] }), size.height + 2);
        cx.clip();
        cx.lineWidth = 1;
        cx.strokeStyle = from === to ? to : tint.interpolate({ inputRange: [0, 1], outputRange: [from, to] });
        cx.stroke(path);
        cx.restore();
        const pulse = look.pulse;
        if (!pulse) return;
        // The pulse: one dash; its head is `travelled` points along the route.
        cx.lineWidth = 2;
        cx.strokeStyle = String(token("blue-light"));
        if (pulse.kind === "live") {
          const travel = (PULSE_SPEED * pulse.period) / 1000;
          cx.setLineDash([PULSE, travel + link.length + 40]);
          // It starts 2pt short of the job, so its round end does not show before it leaves.
          cx.lineDashOffset = props.live.interpolate({ inputRange: [0, 1], outputRange: [PULSE + 2, PULSE + 2 - travel] });
        } else {
          const travel = (PULSE_SPEED * pulse.duration) / 1000;
          const end = pulse.start + pulse.duration;
          cx.setLineDash([PULSE, travel + link.length + 40]);
          cx.lineDashOffset = props.clock.interpolate({ inputRange: [pulse.start, end], outputRange: [PULSE + 2, PULSE + 2 - travel] });
          cx.globalAlpha = props.clock.interpolate({ inputRange: [pulse.start, pulse.start + 1, end - 1, end], outputRange: [0, 1, 1, 0] });
        }
        cx.stroke(path);
      }}
    />
  );
}

/** A link's name for screen readers and, where links can be edited, the trigger of its picker. */
function FlowLinkPicker(props: {
  link: () => FlowLink;
  look: () => LinkLook;
  busy: () => boolean;
  open: () => boolean;
  onOpenChange: (open: boolean) => void;
  onRemove: () => void;
}) {
  const key = untracked(() => props.link().key);
  // A link is one thing (each finished run of the used job starts the other), so all there is to
  // do with it is to remove it.
  const items = (): MenuEntry[] => [{ id: "remove", label: t("todo_flow_remove"), danger: true, onSelect: () => props.onRemove() }];
  const frame = () => ({ left: props.link().hit.x, top: props.link().hit.y, width: props.link().hit.w, height: props.link().hit.h });
  return (
    <If
      when={props.look().edits}
      else={
        <View
          role="image"
          accessibilityLabel={props.look().name}
          testID={`todo-flow-link-${key}`}
          class="absolute"
          style={{ ...frame(), pointerEvents: "none" }}
          {...parts.probe(() => `link-${key}`)}
        />
      }
    >
      <View class="absolute" style={frame()} {...parts.probe(() => `link-${key}`)}>
        <DropdownMenu
          placement="bottom"
          align="center"
          open={props.open()}
          onOpenChange={(open) => props.onOpenChange(open)}
          disabled={props.busy()}
          label={props.look().name}
          testID={`todo-flow-kind-${key}`}
          items={items()}
          trigger={
            <View
              role="button"
              accessibilityLabel={props.look().name}
              tooltip={<Tip text={props.look().name} />}
              testID={`todo-flow-link-${key}`}
              class="rounded-[6px] hover:bg-hover focus-visible:bg-hover aria-expanded:bg-hover"
              style={{ width: props.link().hit.w, height: props.link().hit.h, transitionProperty: "colors", transitionDuration: motionMs(MOTION_NORMAL), transitionTimingFunction: MOTION_EASE_CSS }}
            />
          }
        />
      </View>
    </If>
  );
}

/* ---------- the view ---------- */

export function TodoFlow(props: TodoFlowProps): JSX.Element {
  const mobile = () => !!props.mobile;
  const busy = () => !!props.busy;
  const jobs = () => props.jobs ?? [];
  const metrics = () => (mobile() ? FLOW_PHONE : FLOW_DESKTOP);
  // Once per change of the jobs (or of the layout's direction), never per frame.
  const layout = computed(() => layoutFlow(jobs(), metrics()));
  const graph = computed(() => flowGraph(jobs()));
  const jobById = computed(() => new Map(jobs().map((job) => [job.id, job])));
  const column = computed(() => new Map(layout().nodes.map((node) => [node.id, node.col])));
  const length = computed(() => new Map(layout().links.map((link) => [link.key, link.length])));
  // In reading order (a column after the other, down each), which is the order Tab takes.
  const nodes = computed(() => [...layout().nodes].sort((a, b) => a.col - b.col || a.y - b.y));

  /* view state */
  /** The job whose line is in ink. */
  const sel = signal<string | null>(null);
  /** The job a new link is being drawn from. */
  const linking = signal<string | null>(null);
  /** A link being dragged from a job's port: the job, the valid job under the pointer, and the pointer in the picture. */
  const dragFrom = signal<string | null>(null);
  const dragOver = signal<string | null>(null);
  const dragPoint = signal<{ x: number; y: number } | null>(null);
  /** The link whose picker is open, and the one to open once it is there (a link just asked for). */
  const pop = signal<string | null>(null);
  const pendingPop = signal<string | null>(null);
  /** How far along its path the replay has travelled: a column per step. */
  const step = signal(0);

  // A job that went takes its selection with it.
  effect(() => {
    const known = jobById();
    untracked(() => {
      const selected = sel();
      const from = linking();
      if (selected && !known.has(selected)) sel.set(null);
      if (from && !known.has(from)) linking.set(null);
    });
  });
  // A phone, a replay and a save take no edits.
  const editable = () => !mobile() && !props.replay;
  effect(() => {
    if (editable() && !busy()) return;
    untracked(() => {
      if (linking()) linking.set(null);
    });
  });

  const clear = () =>
    batch(() => {
      sel.set(null);
      linking.set(null);
      pop.set(null);
      pendingPop.set(null);
    });
  // Escape leaves link mode, then the selection (never while a picker is open: it takes the key).
  bindPaneEscape(
    () => (linking() ? linking.set(null) : clear()),
    () => !!(linking() || sel()),
  );

  /* motion: the first entrance, and the links going out while the jobs glide */
  const still = () => untracked(reduceMotion);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (run: () => void, ms: number) => {
    const id = setTimeout(() => {
      timers.delete(id);
      run();
    }, ms);
    timers.add(id);
    return id;
  };
  const drop = (id: ReturnType<typeof setTimeout> | undefined) => {
    if (id === undefined) return;
    clearTimeout(id);
    timers.delete(id);
  };
  cleanup(() => timers.forEach((id) => clearTimeout(id)));
  let booted = still();
  if (!booted) later(() => (booted = true), BOOT_MS);
  // The layout the links are drawn for. While it is not the current one, they are out.
  const drawn = signal(untracked(() => layout().signature));
  const settling = () => drawn() !== layout().signature;
  let settle: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    const signature = layout().signature;
    untracked(() => {
      if (signature === drawn()) return;
      drop(settle);
      const land = () => drawn.set(untracked(() => layout().signature));
      if (motionMs(SETTLE_MS) === 0) land();
      else settle = later(land, SETTLE_MS);
    });
  });
  if (eventListener) {
    let last: boolean | null = null;
    effect(() => {
      const out = settling();
      if (out === last) return;
      last = out;
      untracked(() => eventListener?.(out ? "links:out" : "links:in"));
    });
  }
  // A link just asked for opens its picker once it is drawn (the prototype's next step: its kind);
  // one that has not come after a few seconds (the page refused it, or saved for long) opens nothing.
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    const key = pendingPop();
    untracked(() => {
      drop(pendingTimer);
      pendingTimer = key ? later(() => pendingPop() === key && pendingPop.set(null), PENDING_PICKER_MS) : undefined;
    });
  });
  effect(() => {
    const key = pendingPop();
    if (!key || settling() || busy()) return;
    if (!layout().links.some((link) => link.key === key)) return;
    untracked(() =>
      batch(() => {
        pendingPop.set(null);
        pop.set(key);
      }),
    );
  });

  /* the selection's line */
  const line = computed(() => {
    const id = sel();
    if (!id || !graph().uses.has(id)) return null;
    return { id, up: upstreamOf(graph(), id), down: downstreamOf(graph(), id) };
  });
  const onLine = (id: string) => {
    const at = line();
    return !at || id === at.id || at.up.has(id) || at.down.has(id);
  };
  const linkOnLine = (from: string, to: string) => {
    const at = line();
    if (!at) return true;
    const up = (id: string) => id === at.id || at.up.has(id);
    const down = (id: string) => id === at.id || at.down.has(id);
    return (up(from) && up(to)) || (down(from) && down(to));
  };

  /* the replay */
  const run = computed(() => {
    const steps = props.replay;
    if (!steps) return null;
    const status = new Map<string, FlowRunStep["status"]>();
    const note = new Map<string, string>();
    let first = Infinity;
    let last = 0;
    for (const item of steps) {
      const col = column().get(item.job_id);
      if (col === undefined) continue;
      status.set(item.job_id, item.status);
      note.set(item.job_id, item.note);
      first = Math.min(first, col);
      last = Math.max(last, col);
    }
    return { status, note, first: Number.isFinite(first) ? first : 0, last };
  });
  // One clock for a whole replay, in milliseconds since it started: every pulse and border light
  // is read off it at its own time, natively.
  const clock = createAnimatedValue(0);
  let stepTimers: ReturnType<typeof setTimeout>[] = [];
  effect(() => {
    const steps = props.replay;
    untracked(() => {
      stepTimers.forEach(drop);
      stepTimers = [];
      void clock.stop();
      clock.set(0);
      // A replay starts and ends with nothing selected: its picture is the chain's, not a job's line.
      clear();
      const chain = steps ? run() : null;
      if (!chain) return;
      const reach = (at: number) => {
        step.set(at);
        eventListener?.(`step:${at}:${layout().nodes.filter((node) => chain.status.has(node.id) && node.col <= at).map((node) => node.id).join("+")}`);
      };
      if (motionMs(STEP_MS) === 0) return reach(chain.last);
      reach(chain.first);
      for (let i = 1; i <= chain.last - chain.first; i++) stepTimers.push(later(() => untracked(() => reach(chain.first + i)), i * STEP_MS));
      // Long enough for the last column's pulses over the longest link.
      const longest = Math.max(0, ...layout().links.map((link) => link.length));
      const total = (chain.last - chain.first) * STEP_MS + ((longest + 24) / PULSE_SPEED) * 1000 + LIT_MS;
      void clock.timing(total, { duration: total, easing: Easing.linear });
    });
  });
  /** A pulse leaves a job only with a result: not one that failed, was skipped or was cancelled. */
  const replayTravels = (from: string, to: string) => {
    const chain = run();
    return !!chain && chain.status.get(from) === "done" && chain.status.has(to) && motionMs(STEP_MS) > 0;
  };
  const replayStart = (to: string) => ((column().get(to) ?? 0) - (run()?.first ?? 0)) * STEP_MS;

  /* live: a pulse loops along the `each` links of a running job */
  const liveTravels = (link: FlowLink) => {
    if (props.replay || linking() || settling() || motionMs(LIVE_PERIOD_MS) === 0) return false;
    const from = jobById().get(link.from);
    return !!from && from.running && from.enabled;
  };
  // One lap: the prototype's 1.8s, longer when a route is longer than a pulse travels in that.
  const livePeriod = computed(() => {
    let longest = 0;
    for (const link of layout().links) if (liveTravels(link)) longest = Math.max(longest, link.length);
    return longest ? Math.max(LIVE_PERIOD_MS, Math.ceil(((longest + 3 * PULSE) / PULSE_SPEED) * 1000)) : 0;
  });
  const live = createAnimatedValue(0);
  effect(() => {
    const period = livePeriod();
    untracked(() => {
      void live.stop();
      live.set(0);
      if (period > 0) void live.keyframes([0, 1], { duration: period, easing: Easing.linear, iterations: "infinite" });
    });
  });
  cleanup(() => {
    void live.stop();
    void clock.stop();
  });
  /** When the pulse along `link` gets to its end, after it left. */
  const travelMs = (link: FlowLink) => ((link.length + 2) / PULSE_SPEED) * 1000;

  /* what each job and link shows */
  const jobLooks = computed(() => {
    const looks = new Map<string, JobLook>();
    const chain = run();
    const from = linking();
    // A dragged link marks its targets as link mode does, by restyling only.
    const dragged = dragFrom();
    const source = from ?? dragged;
    const hovered = dragOver();
    const selected = sel();
    const at = step();
    // When the first pulse arrives at each job.
    const arrive = new Map<string, number>();
    for (const link of layout().links) {
      const travels = chain ? replayTravels(link.from, link.to) : liveTravels(link);
      if (!travels) continue;
      arrive.set(link.to, Math.min(arrive.get(link.to) ?? Infinity, travelMs(link)));
    }
    for (const node of layout().nodes) {
      const job = jobById().get(node.id);
      if (!job) continue;
      const status = chain?.status.get(job.id);
      const reached = !!chain && status !== undefined && node.col <= at;
      const failed = reached && status === "failed";
      const target = !!source && canUse(graph(), source, job.id);
      const arrives = arrive.get(job.id);
      // In a replay the pulse into a job leaves as its step begins; the job follows as it arrives.
      const now = reached && node.col === at && arrives !== undefined;
      const lit: Lit =
        arrives === undefined
          ? null
          : chain
            ? { kind: "replay", at: Math.round(replayStart(job.id) + arrives) }
            : { kind: "live", at: Math.round((arrives / livePeriod()) * 1000) / 1000, period: livePeriod() };
      const mark: StatusState = chain ? (failed ? "error" : job.enabled ? "on" : "off") : !job.enabled ? "off" : job.running ? "running" : "on";
      const note = reached ? (chain?.note.get(job.id) ?? job.note) : job.note;
      const state = failed ? t("todo_flow_state_failed") : mark === "running" ? t("todo_flow_state_running") : mark === "off" ? t("todo_flow_state_off") : "";
      const isSelected = job.id === selected;
      looks.set(job.id, {
        job,
        faded: source ? !(target || job.id === source) : chain ? !reached : !onLine(job.id),
        wait: now ? Math.round(arrives as number) : 0,
        selected: isSelected,
        linking: job.id === from,
        target,
        over: !!dragged && target && job.id === hovered,
        canDrag: editable() && !busy() && !from && !pop(),
        pressable: from ? target : true,
        mark,
        note,
        failed,
        reached,
        lit,
        // Every job has its port (shown under the pointer); in link mode only the job it started from.
        canLink: editable() && !busy() && (!from || job.id === from) && !pop(),
        canOpen: isSelected && !from,
        join: node.joined && !chain,
        joinEdits: editable() && !busy() && !from,
        name: target
          ? t("todo_flow_link_target", { job: job.title, used: jobById().get(from as string)?.title ?? "" })
          : [job.title, state, note].filter(Boolean).join(", "),
      });
    }
    return looks;
  });
  const linkLooks = computed(() => {
    const looks = new Map<string, LinkLook>();
    const chain = run();
    const at = step();
    for (const link of layout().links) {
      const from = jobById().get(link.from);
      const to = jobById().get(link.to);
      const name = t("todo_flow_link", { job: to?.title ?? link.to, used: from?.title ?? link.from });
      if (chain) {
        const inRun = chain.status.has(link.from) && chain.status.has(link.to) && (column().get(link.to) ?? 0) <= at;
        const travels = replayTravels(link.from, link.to);
        looks.set(link.key, {
          tone: inRun ? (chain.status.get(link.from) === "failed" ? "danger" : "ink") : "dim",
          faded: !inRun,
          pulse: travels ? { kind: "replay", start: replayStart(link.to), duration: Math.ceil(((link.length + 2 * PULSE) / PULSE_SPEED) * 1000) } : null,
          name,
          edits: false,
        });
        continue;
      }
      const on = linkOnLine(link.from, link.to);
      looks.set(link.key, {
        tone: on && line() ? "ink" : "rest",
        faded: linking() ? true : !on,
        pulse: liveTravels(link) ? { kind: "live", period: livePeriod() } : null,
        name,
        edits: editable() && !linking(),
      });
    }
    return looks;
  });
  const NO_JOB: FlowJob = { id: "", title: "", note: "", enabled: true, running: false, uses: [], join: "all" };
  const jobLook = (id: string): JobLook =>
    jobLooks().get(id) ?? {
      job: NO_JOB,
      faded: false,
      wait: 0,
      selected: false,
      linking: false,
      target: false,
      over: false,
      canDrag: false,
      pressable: false,
      mark: "on",
      note: "",
      failed: false,
      reached: false,
      lit: null,
      canLink: false,
      canOpen: false,
      join: false,
      joinEdits: false,
      name: "",
    };
  const linkLook = (key: string): LinkLook => linkLooks().get(key) ?? { tone: "rest", faded: false, pulse: null, name: "", edits: false };

  /* presses */
  const pressJob = (id: string) => {
    const from = linking();
    if (from) {
      if (!canUse(graph(), from, id) || busy()) return;
      batch(() => {
        linking.set(null);
        sel.set(id);
        pop.set(null);
        pendingPop.set(`${from}>${id}`);
      });
      props.onAddUse?.(id, from);
      return;
    }
    batch(() => {
      sel.set(sel() === id ? null : id);
      pop.set(null);
      pendingPop.set(null);
    });
  };
  const pressLink = (id: string) =>
    batch(() => {
      linking.set(linking() === id ? null : id);
      sel.set(id);
      pop.set(null);
      pendingPop.set(null);
    });
  const openPicker = (link: FlowLink, open: boolean) =>
    batch(() => {
      pendingPop.set(null);
      if (open) {
        pop.set(link.key);
        if (!props.replay) sel.set(link.to);
      } else if (pop() === link.key) pop.set(null);
    });

  /* a link dragged from a port */
  // The picture's place on the page, measured as a drag starts (the picture does not scroll under a held port).
  let layer: ViewRef | undefined;
  let layerOrigin: { x: number; y: number } | null = null;
  let dragRun = 0;
  const endDrag = () =>
    batch(() => {
      dragRun += 1;
      layerOrigin = null;
      dragFrom.set(null);
      dragOver.set(null);
      dragPoint.set(null);
    });
  /** The job at a point of the picture that may use `from`, if any (a job's box, with a little room round it). */
  const targetAt = (from: string, point: { x: number; y: number }) => {
    const ROOM = 6;
    const node = layout().nodes.find(
      (item) => point.x >= item.x - ROOM && point.x <= item.x + item.w + ROOM && point.y >= item.y - ROOM && point.y <= item.y + item.h + ROOM,
    );
    return node && canUse(graph(), from, node.id) ? node.id : null;
  };
  const follow = (page: { x: number; y: number }) => {
    const from = untracked(dragFrom);
    if (!from || !layerOrigin) return;
    const point = { x: page.x - layerOrigin.x, y: page.y - layerOrigin.y };
    batch(() => {
      dragPoint.set(point);
      dragOver.set(targetAt(from, point));
    });
  };
  const linkDrag = (id: string, phase: "start" | "move" | "drop" | "cancel", page?: { x: number; y: number }) => {
    if (phase === "start") {
      if (!untracked(editable) || untracked(busy) || untracked(linking)) return;
      const run = ++dragRun;
      layerOrigin = null;
      batch(() => {
        dragFrom.set(id);
        dragOver.set(null);
        dragPoint.set(null);
      });
      void layer
        ?.measure()
        .then((frame) => {
          if (run !== dragRun || !frame) return;
          layerOrigin = { x: frame.pagePosition.x, y: frame.pagePosition.y };
          if (page) follow(page);
        })
        .catch((error) => console.warn("todo flow: could not place the picture for a dragged link", error));
      return;
    }
    if (untracked(dragFrom) !== id) return;
    if (phase === "move" && page) return follow(page);
    if (phase === "drop") {
      if (page) follow(page);
      const to = untracked(dragOver);
      endDrag();
      // The job that takes the link is selected, so its line shows in ink. No picker opens: the
      // link was put where it was meant, and its picker would only offer to remove it.
      if (to && !untracked(busy)) {
        batch(() => {
          sel.set(to);
          pop.set(null);
          pendingPop.set(null);
        });
        props.onAddUse?.(to, id);
      }
      return;
    }
    endDrag();
  };
  // A job that went, or a picture that takes no edits any more, ends a drag.
  effect(() => {
    const from = dragFrom();
    if (!from) return;
    if (!jobById().has(from) || !editable() || busy()) untracked(endDrag);
  });

  /* the page */
  const viewport = signal({ width: 0, height: 0 });
  const padX = () => (mobile() ? gutterX() : Math.max(gutterX(), 24));
  // Clear of link mode's line of words over the top (23pt).
  const padTop = () => (mobile() ? 16 : 28);
  // The phone's bottom navigation floats over the foot of the page.
  const padBottom = () => (mobile() ? 84 : gutterY() * 2 + 20);
  const canvasWidth = () => layout().width + 2 * INSET;
  const canvasHeight = () => layout().height + 2 * INSET + FOOT;
  const linkingTitle = () => jobById().get(linking() ?? "")?.title ?? "";
  return (
    <View
      class="flex-1"
      role="region"
      accessibilityLabel={t("todo_flow_label")}
      testID="todo-flow"
      onLayout={(event) => viewport.set({ width: event.bounds.size.width, height: event.bounds.size.height })}
    >
      {/* Sideways outside, down inside: the outer scroller is the view's own size, so its bar (the
          one a mouse needs: a wheel only goes down) lies at the view's foot. Nested the other way,
          the sideways scroller was as tall as the picture and its bar lay below the window. */}
      <Scroll
        horizontal
        class="flex-1"
        scrollbar={SCROLLBAR}
        testID="todo-flow-scroll-x"
        onScroll={eventListener ? (event) => eventListener?.(`scroll-x:${Math.round(event.offset.x)}`) : undefined}
        {...parts.probe(() => "scroll-x")}
      >
        <Scroll
          scrollbar={SCROLLBAR}
          style={{ height: viewport().height }}
          testID="todo-flow-scroll"
          onScroll={eventListener ? (event) => eventListener?.(`scroll-y:${Math.round(event.offset.y)}`) : undefined}
          {...parts.probe(() => "scroll-y")}
        >
          {/* Empty space: a press clears the selection (Escape does for the keyboard). */}
          <View
            role="group"
            focusable={false}
            onPress={() => clear()}
            testID="todo-flow-ground"
            style={{
              minWidth: viewport().width,
              minHeight: viewport().height,
              paddingLeft: padX() - INSET,
              paddingRight: padX() - INSET,
              paddingTop: padTop() - INSET,
              paddingBottom: padBottom(),
            }}
          >
            {/* Clipped: an icon in a scroller counts its file's size, not its drawn size, as overflow (PORTING.md). */}
            <View class="overflow-hidden" style={{ width: canvasWidth(), height: canvasHeight() }} testID="todo-flow-canvas" {...parts.probe(() => "canvas")}>
              <View
                class="absolute"
                style={{ left: INSET, top: INSET, width: layout().width, height: layout().height + FOOT }}
                ref={(view: ViewRef) => {
                  layer = view;
                }}
              >
                <If when={!settling()}>
                  <Each of={layout().links} key={(link) => link.key}>
                    {(link) => (
                      <FlowLinkLine
                        link={link}
                        look={() => linkLook(link().key)}
                        drawDelay={() => (booted ? 0 : DRAW_AFTER_ENTRANCE_MS) + (column().get(link().from) ?? 0) * DRAW_STEP_MS}
                        live={live}
                        clock={clock}
                      />
                    )}
                  </Each>
                </If>
                <Each of={nodes()} key={(node) => node.id}>
                  {(node) => (
                    <FlowJobBox
                      node={node}
                      look={() => jobLook(node().id)}
                      enterDelay={() => (booted ? 0 : node().col * RISE_STEP_MS)}
                      live={live}
                      clock={clock}
                      onPress={() => pressJob(node().id)}
                      onOpen={() => props.onOpenJob?.(node().id)}
                      onLink={() => pressLink(node().id)}
                      onJoin={() => props.onSetJoin?.(node().id, jobById().get(node().id)?.join === "any" ? "all" : "any")}
                      onLinkDrag={(phase, page) => linkDrag(node().id, phase, page)}
                    />
                  )}
                </Each>
                {/* The link being dragged: a line from its job's port to the pointer, over the jobs.
                    Always there (a view added mid-gesture ends the gesture); it draws only while a link is dragged. */}
                <Canvas
                  accessibilityElementsHidden
                  class="absolute inset-0"
                  style={{ pointerEvents: "none" }}
                  testID={`todo-flow-drag-${dragFrom() ? (dragOver() ? "over" : "on") : "off"}`}
                  draw={(cx) => {
                    const from = dragFrom();
                    const to = dragPoint();
                    const node = from ? layout().nodes.find((item) => item.id === from) : undefined;
                    if (!node || !to) return;
                    const start = { x: node.x + node.w, y: node.y + node.h / 2 };
                    // Leaves the port sideways and arrives sideways, as the links do.
                    const reach = Math.max(24, Math.abs(to.x - start.x) / 2);
                    cx.lineWidth = 1.5;
                    cx.lineCap = "round";
                    cx.strokeStyle = String(token("blue"));
                    if (!dragOver()) cx.setLineDash([4, 4]);
                    cx.beginPath();
                    cx.moveTo(start.x, start.y);
                    cx.bezierCurveTo(start.x + reach, start.y, to.x - reach, to.y, to.x, to.y);
                    cx.stroke();
                  }}
                />
                <If when={!settling()}>
                  <Each of={layout().links} key={(link) => link.key}>
                    {(link) => (
                      <FlowLinkPicker
                        link={link}
                        look={() => linkLook(link().key)}
                        busy={busy}
                        open={() => pop() === link().key}
                        onOpenChange={(open) => openPicker(link(), open)}
                        onRemove={() => props.onRemoveUse?.(link().to, link().from)}
                      />
                    )}
                  </Each>
                </If>
              </View>
            </View>
          </View>
        </Scroll>
      </Scroll>
      {/* Link mode says what to do next, over the picture's top; screen readers hear it as it comes. */}
      <If when={linking()}>
        <View class="absolute left-0 right-0 top-0 bg-paper/95" style={{ paddingHorizontal: padX(), paddingVertical: 2, pointerEvents: "none" }}>
          <Text role="alert" class="text-[13px] leading-[19px] text-muted-foreground" testID="todo-flow-hint">
            {t("todo_flow_link_hint", { job: linkingTitle() })}
          </Text>
        </View>
      </If>
    </View>
  );
}
