// Dragging a topic onto a tag group in the topic list's tag view tags it with the group's tag, as
// the Vue console's draggable topics did.
//
// nsh has no DOM drag and drop, so the row is a `PanResponder`. With a mouse or a trackpad (desktops)
// it takes the gesture once a press on it has moved a few points (the press is cancelled, the topic
// stays unopened). On a touch screen a swipe must stay the list's scroll, so a finger first rests on
// the topic (`TOPIC_HOLD_MS`, within `TOPIC_HOLD_SLOP`): the row then lifts and the groups it can go
// to are outlined, and the next move of that finger makes the row the responder, which keeps the
// scroll view from taking the touches (nsh's `SetJsResponder`: on Android the list's `ScrollBox`
// neither intercepts nor scrolls while it is set). A finger that moves before, or a list that
// scrolls, never lifts anything; one that lets go of a lifted row without moving drops nothing and
// opens nothing. nsh/base's `Button` takes no `onLongPress`, so the hold is timed here, from the
// row's own touch events (which every listening view hears, before the responder's).
//
// Where the pointer is in the list comes from the list content's place on the screen (`measure()`,
// once per drag) and the scroll since; the groups' zones come from their rows' frames (`onLayout`,
// relative to that content): a group runs from its heading to the next one's. The groups the topic
// can go to are outlined while it is dragged, the one under the pointer filled; the outlines are in
// every heading from the start, only restyled (a view added to the list mid-gesture ends the gesture
// in nsh 0.4.0). Letting go over one drops it there; anywhere else, Escape, a gesture the system
// takes away, the tag view going or the row going, change nothing.
import { cleanup, computed, effect, keymap, PanResponder, platform, signal, untracked, type ViewRef } from "nsh";
import type { TopicRow } from "./chatController";

type Point = { x: number; y: number };
type Bounds = { origin: Point; size: { width: number; height: number } };

/** How far a press moves before it is a drag, in points (mouse and trackpad). */
export const TOPIC_DRAG_SLOP = 6;
/** How long a finger rests on a topic before the topic lifts for a drag, in ms (touch screens). */
export const TOPIC_HOLD_MS = 450;
/** How far a resting finger may wander meanwhile, in points (Android's own touch slop is 8dp). */
export const TOPIC_HOLD_SLOP = 8;
/** How long after a hold ends its row's press is still not a press, in ms. */
const PRESS_TAKEN_MS = 1000;

/** A group's part of the list's content: where a dragged topic lands in that group. */
export interface TopicDropZone {
  key: string;
  group: any;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The groups' zones in the list's content, from the rows in order and their frames: each group
 * from the top of its heading to the top of the next group's heading, the last one to the foot of
 * its last row. A row with no frame yet is left out.
 */
export function topicDropZones(rows: readonly TopicRow[], frames: ReadonlyMap<string, Bounds>): TopicDropZone[] {
  const zones: TopicDropZone[] = [];
  let open: TopicDropZone | null = null;
  let foot = 0;
  const close = (end: number) => {
    if (open) zones.push({ ...open, height: Math.max(0, end - open.y) });
    open = null;
  };
  for (const row of rows) {
    const frame = frames.get(row.key);
    if (!frame || row.kind === "note") continue;
    if (row.kind === "group") {
      close(frame.origin.y);
      open = { key: row.group?.key ?? row.key, group: row.group, x: frame.origin.x, y: frame.origin.y, width: frame.size.width, height: 0 };
    }
    foot = frame.origin.y + frame.size.height;
  }
  close(foot);
  return zones;
}

/** The zone at a point of the list's content, if any. */
export function topicDropZoneAt(zones: readonly TopicDropZone[], point: Point | null): TopicDropZone | null {
  if (!point) return null;
  return zones.find((zone) => point.y >= zone.y && point.y < zone.y + zone.height && point.x >= zone.x && point.x <= zone.x + zone.width) ?? null;
}

interface Drag {
  id: number;
  topic: any;
  rowKey: string;
  /** Where the press went down and where the pointer is now (surface points). */
  start: Point;
  page: Point;
  /** The list content's top left corner on the surface, and the scroll offset then; null until measured. */
  origin: Point | null;
  originScroll: number;
}

/** A finger on a topic's row (touch screens), from its touch's start until it ends. */
interface Hold {
  rowKey: string;
  topic: any;
  /** Where it went down (surface points). */
  start: Point;
  /** The scroll offset then: a list that scrolls meanwhile is the list's gesture. */
  scroll: number;
  /** Ends the wait for the hold. */
  stop: (() => void) | null;
  /** It rested long enough: the topic is lifted. */
  lifted: boolean;
  /** Its row became the responder: the drag follows the finger. */
  granted: boolean;
}

/** Runs `fn` in `ms`; what it returns stops that. */
export type TopicDragSchedule = (fn: () => void, ms: number) => () => void;

const timeout: TopicDragSchedule = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

type TouchLike = { pageX: number; pageY: number; touches?: readonly unknown[] };
const pageOf = (event: TouchLike): Point => ({ x: Number(event.pageX) || 0, y: Number(event.pageY) || 0 });

export function createTopicDrag(options: {
  /** The list's rows, as rendered. */
  rows: () => TopicRow[];
  /** The rows' top inset within the scroll content (a search can precede them). */
  contentInset?: () => number;
  /** Topics can be dragged now (the tag view). */
  enabled: () => boolean;
  /** The topic can be dropped on the group (it would gain a tag). */
  canDrop: (topic: any, group: any) => boolean;
  /** The topic was dropped on a group it can go to. */
  drop: (topic: any, group: any) => void;
  /** A touch screen's gesture (a hold, then the drag) rather than a mouse's; default: not a desktop. */
  touch?: boolean;
  /** The hold's timer (tests pass their own). */
  schedule?: TopicDragSchedule;
}) {
  const touchScreen = options.touch ?? !platform.desktop;
  const schedule = options.schedule ?? timeout;
  const frames = new Map<string, Bounds>();
  // Bumped when a frame changes mid-drag, so the zones follow a list that changes under it.
  const framesChanged = signal(0);
  const scrollY = signal(0);
  const viewportHeight = signal(Number.POSITIVE_INFINITY);
  const drag = signal<Drag | null>(null);
  let content: ViewRef | null = null;
  let measuring: Promise<void> = Promise.resolve();
  let unbindKeys: (() => void) | null = null;
  let nextID = 0;
  let hold: Hold | null = null;
  // The row whose press a hold took (letting go of a lifted topic opens nothing), for a moment
  // after the hold ends: the press arrives after the touch's end.
  let pressTaken: { rowKey: string; stop: () => void } | null = null;

  // The pointer in the list's content, while it is over the list's viewport.
  const pointer = computed((): Point | null => {
    const d = drag();
    if (!d || !d.origin) return null;
    const point = { x: d.page.x - d.origin.x, y: d.page.y - d.origin.y + (scrollY() - d.originScroll) };
    const inView = point.y - scrollY() + (options.contentInset?.() ?? 0);
    return inView >= 0 && inView <= viewportHeight() ? point : null;
  });
  const zones = computed(() => {
    framesChanged();
    return drag() ? topicDropZones(options.rows(), frames) : [];
  });
  const targets = computed(() => {
    const d = drag();
    return d ? zones().filter((zone) => options.canDrop(d.topic, zone.group)) : [];
  });
  const over = computed(() => topicDropZoneAt(targets(), pointer()));

  function endDrag() {
    unbindKeys?.();
    unbindKeys = null;
    drag.set(null);
  }

  function endHold() {
    const h = hold;
    if (!h) return;
    hold = null;
    h.stop?.();
    if (h.lifted) takePress(h.rowKey);
  }

  /** The gesture ends: whatever it held or dragged goes, nothing dropped. */
  function finish() {
    endHold();
    endDrag();
  }

  function takePress(rowKey: string) {
    pressTaken?.stop();
    const taken = { rowKey, stop: () => {} };
    taken.stop = schedule(() => {
      if (pressTaken === taken) pressTaken = null;
    }, PRESS_TAKEN_MS);
    pressTaken = taken;
  }

  function start(topic: any, rowKey: string, from: Point, page: Point) {
    endDrag();
    const id = ++nextID;
    drag.set({ id, topic, rowKey, start: from, page, origin: null, originScroll: 0 });
    // Escape drops nothing, even with the composer focused.
    unbindKeys = keymap.bind("escape", () => finish(), { when: "always" });
    const measured = content ? content.measure() : Promise.resolve(null);
    measuring = measured
      .then((m) => {
        const d = untracked(drag);
        if (m && d && d.id === id) drag.set({ ...d, origin: m.pagePosition, originScroll: untracked(scrollY) });
      })
      .catch((error) => console.warn("topic drag: could not place the topic list", error));
  }

  function move(page: Point) {
    const d = untracked(drag);
    if (d) drag.set({ ...d, page });
  }

  async function release(page: Point) {
    const d = untracked(drag);
    if (!d) return;
    move(page);
    if (!d.origin) await measuring;
    if (untracked(drag)?.id !== d.id) return; // cancelled meanwhile
    const target = untracked(over);
    endDrag();
    if (target) options.drop(d.topic, target.group);
  }

  // A touch screen's gesture, step by step (the row's touch and responder events call these).
  const touch = {
    /** A finger went down on the row: the wait for the hold starts. */
    start(rowKey: string, topic: any, page: Point, fingers = 1) {
      if (hold?.granted) return; // another finger while one drags: that one goes on
      finish();
      pressTaken?.stop();
      pressTaken = null;
      if (fingers > 1 || !untracked(options.enabled)) return;
      const h: Hold = { rowKey, topic, start: page, scroll: untracked(scrollY), stop: null, lifted: false, granted: false };
      hold = h;
      h.stop = schedule(() => {
        h.stop = null;
        if (hold !== h || !untracked(options.enabled)) return;
        h.lifted = true;
        start(h.topic, h.rowKey, h.start, h.start);
      }, TOPIC_HOLD_MS);
    },
    /** The finger moved (before the row is the responder): wandering off is a swipe, the list's. */
    move(page: Point) {
      const h = hold;
      if (!h || h.lifted) return;
      if (Math.hypot(page.x - h.start.x, page.y - h.start.y) > TOPIC_HOLD_SLOP) endHold();
    },
    /** Whether the row takes the gesture now: its topic is lifted and the finger moves. */
    claims(rowKey: string) {
      const h = hold;
      return Boolean(h && h.lifted && !h.granted && h.rowKey === rowKey && untracked(drag)?.rowKey === rowKey && untracked(options.enabled));
    },
    /** The row is the responder: the topic follows the finger. */
    grant(page: Point) {
      if (hold) hold.granted = true;
      move(page);
    },
    /** The finger moved, as the responder. */
    follow: (page: Point) => move(page),
    /** The finger let go, as the responder: drops the topic where it is. */
    release(page: Point) {
      endHold();
      void release(page);
    },
    /** The touch ended or was taken away before the row was the responder: nothing drops. */
    end() {
      if (!hold || hold.granted) return; // the responder's release or termination ends it
      finish();
    },
    /** The system (or another view) took the gesture from the responder: nothing drops. */
    terminate: () => finish(),
    /** The list scrolled: before a drag, a scroll ends the hold. */
    scrolled(offset: number) {
      const h = hold;
      if (h && !h.granted && Math.abs(offset - h.scroll) > 0.5) finish();
    },
  };

  // The view stops taking drags (another view than the tags): what is held or dragged goes.
  effect(() => {
    if (!options.enabled()) untracked(() => (hold || drag() ? finish() : undefined));
  });
  cleanup(() => {
    finish();
    pressTaken?.stop();
    pressTaken = null;
  });

  return {
    /** `ref` of the view holding the rows (the frames are relative to it). */
    contentRef: (ref: ViewRef | null) => {
      content = ref;
    },
    /** `onLayout` of a row the zones are measured from (group headings and topics). */
    track: (key: string) => (event: { bounds: Bounds }) => {
      frames.set(key, event.bounds);
      if (untracked(drag)) framesChanged.update((n) => n + 1);
    },
    /** The scroll view's `onScroll` and `onLayout`. */
    onScroll: (event: { offset: Point }) => {
      const y = Number(event?.offset?.y) || 0;
      scrollY.set(y);
      touch.scrolled(y);
    },
    onViewportLayout: (event: { bounds: { size: { height: number } } }) => viewportHeight.set(event.bounds.size.height),
    /** The touch handlers of a topic's row (call them in the row's scope). */
    handlers(row: () => Extract<TopicRow, { kind: "topic" }>) {
      const key = untracked(row).key;
      // The row goes mid-gesture (the list changed): so does the gesture, which nsh then ends silently.
      cleanup(() => {
        if (hold?.rowKey === key || untracked(drag)?.rowKey === key) finish();
      });
      if (touchScreen) {
        const pan = PanResponder.create({
          onMoveShouldSetPanResponder: () => touch.claims(key),
          onPanResponderGrant: (event) => touch.grant(pageOf(event)),
          onPanResponderMove: (event) => touch.follow(pageOf(event)),
          onPanResponderRelease: (event) => touch.release(pageOf(event)),
          onPanResponderTerminate: () => touch.terminate(),
          // Neither the list's scroll view nor a view around takes a dragged topic away.
          onPanResponderTerminationRequest: () => false,
          onShouldBlockNativeResponder: () => true,
        }).panHandlers;
        return {
          ...pan,
          onTouchStart: (event: TouchLike) => touch.start(key, untracked(row).topic, pageOf(event), event.touches?.length ?? 1),
          onTouchMove: (event: TouchLike) => touch.move(pageOf(event)),
          onTouchEnd: () => touch.end(),
          onTouchCancel: () => touch.end(),
        };
      }
      let from: Point = { x: 0, y: 0 };
      return PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) => {
          if (!untracked(options.enabled) || Math.hypot(gesture.dx, gesture.dy) < TOPIC_DRAG_SLOP) return false;
          from = { x: gesture.x0, y: gesture.y0 };
          return true;
        },
        onPanResponderGrant: (event) => {
          const r = untracked(row);
          start(r.topic, r.key, from, { x: event.pageX, y: event.pageY });
        },
        onPanResponderMove: (event) => move({ x: event.pageX, y: event.pageY }),
        onPanResponderRelease: (event) => void release({ x: event.pageX, y: event.pageY }),
        onPanResponderTerminate: () => finish(),
        // The list's scroll view does not take a topic away mid-drag.
        onPanResponderTerminationRequest: () => false,
      }).panHandlers;
    },
    /**
     * Whether a press on the row is one a hold took (its topic was lifted, then let go): the
     * row's `onPress` opens nothing then. Asking uses the answer up.
     */
    pressTaken(rowKey: string) {
      if (pressTaken?.rowKey !== rowKey) return false;
      pressTaken.stop();
      pressTaken = null;
      return true;
    },
    /** A touch screen's gesture, step by step (tests drive it; the rows' handlers call it). */
    touch,
    /** This row is the one being dragged. */
    lifted: (rowKey: string) => drag()?.rowKey === rowKey,
    /**
     * The row's tooltip goes while it is dragged with a mouse (it would cover the groups). Touch
     * screens never show tooltips, and a tooltip's view going from inside a row a finger holds
     * is a change to its views mid-gesture, so theirs stays.
     */
    hidesTip: (rowKey: string) => !touchScreen && drag()?.rowKey === rowKey,
    /** The row being dragged, lifted and following the pointer; nothing for the others. */
    liftStyle(rowKey: string) {
      const d = drag();
      if (!d || d.rowKey !== rowKey) return undefined;
      return {
        transform: [{ translateX: d.page.x - d.start.x }, { translateY: d.page.y - d.start.y }],
        zIndex: 10,
        cursor: "grabbing" as const,
      };
    },
    /**
     * A group's part in the drag: "over" when the topic would drop there, "target" when it can,
     * else "none". Views are only restyled meanwhile, never added: a view added to the list while a
     * row has the gesture ends the gesture (nsh 0.4.0).
     */
    zoneState(groupKey: string): "none" | "target" | "over" {
      if (over()?.key === groupKey) return "over";
      return targets().some((zone) => zone.key === groupKey) ? "target" : "none";
    },
    /** The height of a group's zone while the topic can go there, else 0. */
    zoneHeight: (groupKey: string) => targets().find((zone) => zone.key === groupKey)?.height ?? 0,
  };
}
