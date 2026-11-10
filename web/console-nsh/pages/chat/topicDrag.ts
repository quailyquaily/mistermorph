// Dragging a topic onto a tag group in the topic list's tag view tags it with the group's tag, as
// the Vue console's draggable topics did. Desktops only (a mouse or a trackpad): on touch screens a
// drag scrolls the list, and the Topic panel's tag editor stays the way to tag a topic there.
//
// nsh has no DOM drag and drop, so the row is a `PanResponder`: once a press on it has moved a few
// points it takes the gesture (the press is cancelled, the topic stays unopened) and follows the
// pointer, lifted. Where the pointer is in the list comes from the list content's place on the
// screen (`measure()`, once per drag) and the scroll since; the groups' zones come from their rows'
// frames (`onLayout`, relative to that content): a group runs from its heading to the next one's.
// The groups the topic can go to are outlined while it is dragged, the one under the pointer
// filled; the outlines are in every heading from the start, only restyled (a view added to the
// list mid-gesture ends the gesture in nsh 0.4.0). Letting go over one drops it there; anywhere else, Escape, or a gesture the system takes
// away, change nothing.
import { cleanup, computed, keymap, PanResponder, platform, signal, untracked, type ViewRef } from "nsh";
import type { TopicRow } from "./chatController";

type Point = { x: number; y: number };
type Bounds = { origin: Point; size: { width: number; height: number } };

/** How far a press moves before it is a drag, in points. */
export const TOPIC_DRAG_SLOP = 6;

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

export function createTopicDrag(options: {
  /** The list's rows, as rendered. */
  rows: () => TopicRow[];
  /** Topics can be dragged now (the tag view). */
  enabled: () => boolean;
  /** The topic can be dropped on the group (it would gain a tag). */
  canDrop: (topic: any, group: any) => boolean;
  /** The topic was dropped on a group it can go to. */
  drop: (topic: any, group: any) => void;
}) {
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

  // The pointer in the list's content, while it is over the list's viewport.
  const pointer = computed((): Point | null => {
    const d = drag();
    if (!d || !d.origin) return null;
    const point = { x: d.page.x - d.origin.x, y: d.page.y - d.origin.y + (scrollY() - d.originScroll) };
    const inView = point.y - scrollY();
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

  function finish() {
    unbindKeys?.();
    unbindKeys = null;
    drag.set(null);
  }

  function start(topic: any, rowKey: string, from: Point, page: Point) {
    finish();
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
    finish();
    if (target) options.drop(d.topic, target.group);
  }

  cleanup(finish);

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
    onScroll: (event: { offset: Point }) => scrollY.set(Number(event?.offset?.y) || 0),
    onViewportLayout: (event: { bounds: { size: { height: number } } }) => viewportHeight.set(event.bounds.size.height),
    /** The touch handlers of a topic's row (none on touch screens). */
    handlers(row: () => Extract<TopicRow, { kind: "topic" }>) {
      if (!platform.desktop) return {};
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
    /** This row is the one being dragged. */
    lifted: (rowKey: string) => drag()?.rowKey === rowKey,
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
