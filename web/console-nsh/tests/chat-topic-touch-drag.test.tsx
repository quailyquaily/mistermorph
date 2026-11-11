// Dragging a topic onto a tag group on a touch screen (the Android app): a finger rests on the
// topic until it lifts (TOPIC_HOLD_MS, within TOPIC_HOLD_SLOP), then its next move takes the
// gesture and letting go over a group the topic can go to drops it there. A swipe before that, a
// list that scrolls, a lifted topic let go without moving, a gesture the system takes, a group the
// topic cannot go to, a list with nothing measured and the tag view going drop nothing.
//
// The gesture's steps are driven on the module (`touch`: what the row's touch and responder
// events call), with a timer of the test's own: headless `nsh test` cannot rest a finger and then
// move it in one gesture (`dragAndHold` moves at once, `longPress` needs an `onLongPress` view and
// lifts). The app's own tests below rest a finger within the slop (`dragAndHold` by 2pt and a
// wait), which is as far as headless goes. Neither is the Android runtime's touch handling
// (its scroll views, its touch slop, the timing of its events), which only a device shows.
import { expect, test } from "nsh/test";
import { effect, signal, untracked, type ViewRef } from "nsh";
import { openConsole, type ApiRequest } from "./harness";
import { createTopicDrag, TOPIC_HOLD_MS, TOPIC_HOLD_SLOP, type TopicDragSchedule } from "../pages/chat/topicDrag";
import type { TopicRow } from "../pages/chat/chatController";

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

// The list's content, at (0, 100) on the surface, rows 16pt in and 200 wide:
//   Pinned    0  · Trip plans 32  (pinned, travel)
//   food     78  · Recipes   110  (food)
//   travel  156  · Soups     188  (food, travel)
//   Untagged 234 · Ideas     266  (none)
// so the zones are pinned 0–78, food 78–156, travel 156–234 and untagged 234–306: a finger at
// y 290 on the surface is over travel, at 200 over food, at 140 over the pinned group.
const pinned = { key: "pinned", pinned: true, label: "Pinned" };
const food = { key: "tag:food", label: "food", drop: { kind: "tag", tag: "food" } };
const travel = { key: "tag:travel", label: "travel", drop: { kind: "tag", tag: "travel" } };
const untagged = { key: "tag:", label: "Untagged", untagged: true, drop: { kind: "untagged" } };
const trip = { id: "trip", tags: ["pinned", "travel"] };
const recipes = { id: "recipes", tags: ["food"] };
const soups = { id: "soups", tags: ["food", "travel"] };
const ideas = { id: "ideas", tags: [] as string[] };

const group = (g: any): TopicRow => ({ kind: "group", key: `group:${g.key}`, group: g, collapsible: true, collapsed: false });
const topicRow = (g: any, t: any): Extract<TopicRow, { kind: "topic" }> => ({ kind: "topic", key: `topic:${g.key}:${t.id}`, topic: t, group: g });
const ROWS: TopicRow[] = [
  group(pinned),
  topicRow(pinned, trip),
  group(food),
  topicRow(food, recipes),
  group(travel),
  topicRow(travel, soups),
  group(untagged),
  topicRow(untagged, ideas),
];
const TOPS = [0, 32, 78, 110, 156, 188, 234, 266];
const RECIPES = "topic:tag:food:recipes";
const IDEAS = "topic:tag::ideas";
const AT_RECIPES = { x: 100, y: 230 };
const OVER_TRAVEL = { x: 100, y: 290 };

/** A timer the test runs by hand. */
function manualTimers() {
  let now = 0;
  const due: { at: number; fn: () => void; stopped: boolean }[] = [];
  const schedule: TopicDragSchedule = (fn, ms) => {
    const timer = { at: now + ms, fn, stopped: false };
    due.push(timer);
    return () => {
      timer.stopped = true;
    };
  };
  const advance = (ms: number) => {
    now += ms;
    for (const timer of due.filter((t) => !t.stopped && t.at <= now)) {
      timer.stopped = true;
      timer.fn();
    }
  };
  return { schedule, advance };
}

function setup(options: { rows?: TopicRow[]; measured?: boolean } = {}) {
  const timers = manualTimers();
  const enabled = signal(true);
  const drops: [string, string][] = [];
  let drag!: ReturnType<typeof createTopicDrag>;
  effect(() => {
    untracked(() => {
      drag = createTopicDrag({
        rows: () => options.rows ?? ROWS,
        enabled: () => enabled(),
        canDrop: (topic, g) => g?.drop?.kind === "tag" && !topic.tags.includes(g.drop.tag),
        drop: (topic, g) => drops.push([topic.id, g.key]),
        touch: true,
        schedule: timers.schedule,
      });
    });
  });
  const content = {
    measure: async () => (options.measured === false ? null : { pagePosition: { x: 0, y: 100 }, bounds: { origin: { x: 0, y: 0 }, size: { width: 232, height: 320 } } }),
  };
  drag.contentRef(content as unknown as ViewRef);
  drag.onViewportLayout({ bounds: { size: { height: 600 } } });
  (options.rows ?? ROWS).forEach((row, i) => {
    drag.track(row.key)({ bounds: { origin: { x: 16, y: TOPS[i] }, size: { width: 200, height: row.kind === "group" ? 30 : 40 } } });
  });
  const zones = () => Object.fromEntries([pinned, food, travel, untagged].map((g) => [g.key, drag.zoneState(g.key)]));
  /** A finger down on Recipes, resting until it lifts. */
  const lift = async (rowKey = RECIPES, topic: any = recipes) => {
    drag.touch.start(rowKey, topic, AT_RECIPES);
    timers.advance(TOPIC_HOLD_MS);
    await settle();
  };
  return { drag, timers, enabled, drops, zones, lift };
}

test("a finger resting on a topic lifts it; its next move drags it and letting go over a group drops it", async () => {
  const t = setup();
  t.drag.touch.start(RECIPES, recipes, AT_RECIPES);
  // Not yet: the row takes no gesture, nothing is lifted or outlined.
  t.timers.advance(TOPIC_HOLD_MS - 50);
  expect(t.drag.touch.claims(RECIPES)).toBe(false);
  expect(t.drag.lifted(RECIPES)).toBe(false);
  expect(t.zones()["tag:travel"]).toBe("none");
  t.timers.advance(50);
  await settle();
  // Lifted where it was, the groups it can go to outlined (travel; not its own food group, not the
  // pinned or untagged ones), none filled while the finger is still over its own group.
  expect(t.drag.lifted(RECIPES)).toBe(true);
  expect(t.drag.liftStyle(RECIPES)?.transform).toEqual([{ translateX: 0 }, { translateY: 0 }]);
  expect(t.zones()).toEqual({ pinned: "none", "tag:food": "none", "tag:travel": "target", "tag:": "none" });
  // Another row does not take it; this one does, on the next move.
  expect(t.drag.touch.claims(IDEAS)).toBe(false);
  expect(t.drag.touch.claims(RECIPES)).toBe(true);
  t.drag.touch.grant({ x: 100, y: 232 });
  expect(t.drag.touch.claims(RECIPES)).toBe(false);
  t.drag.touch.follow(OVER_TRAVEL);
  expect(t.zones()["tag:travel"]).toBe("over");
  expect(t.drag.liftStyle(RECIPES)?.transform).toEqual([{ translateX: 0 }, { translateY: 60 }]);
  t.drag.touch.release(OVER_TRAVEL);
  await settle();
  expect(t.drops).toEqual([["recipes", "tag:travel"]]);
  // The feedback goes with the drop.
  expect(t.drag.lifted(RECIPES)).toBe(false);
  expect(t.zones()["tag:travel"]).toBe("none");
});

test("a finger that moves before the hold is the list's swipe: nothing lifts", async () => {
  const t = setup();
  t.drag.touch.start(RECIPES, recipes, AT_RECIPES);
  t.timers.advance(100);
  // Within the slop it still rests...
  t.drag.touch.move({ x: AT_RECIPES.x + TOPIC_HOLD_SLOP - 1, y: AT_RECIPES.y });
  // ...past it, it is a swipe.
  t.drag.touch.move({ x: AT_RECIPES.x, y: AT_RECIPES.y + TOPIC_HOLD_SLOP + 1 });
  t.timers.advance(TOPIC_HOLD_MS);
  await settle();
  expect(t.drag.lifted(RECIPES)).toBe(false);
  expect(t.drag.touch.claims(RECIPES)).toBe(false);
  expect(t.zones()["tag:travel"]).toBe("none");
  t.drag.touch.end();
  expect(t.drops).toEqual([]);
  expect(t.drag.pressTaken(RECIPES)).toBe(false);
});

test("a list that scrolls before the drag ends the hold, lifted or not", async () => {
  const t = setup();
  // The list scrolls while the finger waits (the scroll view took it): nothing lifts.
  t.drag.touch.start(RECIPES, recipes, AT_RECIPES);
  t.drag.onScroll({ offset: { x: 0, y: 12 } });
  t.timers.advance(TOPIC_HOLD_MS);
  await settle();
  expect(t.drag.lifted(RECIPES)).toBe(false);
  // Lifted, then the list scrolls before the row took the gesture: it goes down again.
  await t.lift();
  expect(t.drag.lifted(RECIPES)).toBe(true);
  t.drag.onScroll({ offset: { x: 0, y: 40 } });
  expect(t.drag.lifted(RECIPES)).toBe(false);
  expect(t.drag.touch.claims(RECIPES)).toBe(false);
  expect(t.zones()["tag:travel"]).toBe("none");
  t.drag.touch.end();
  expect(t.drops).toEqual([]);
});

test("letting go of a lifted topic without moving drops nothing and opens nothing; a tap still opens", async () => {
  const t = setup();
  await t.lift();
  expect(t.zones()["tag:travel"]).toBe("target");
  t.drag.touch.end();
  expect(t.drag.lifted(RECIPES)).toBe(false);
  expect(t.zones()["tag:travel"]).toBe("none");
  expect(t.drops).toEqual([]);
  // The row's press that follows is the hold's (once), and only for a moment.
  expect(t.drag.pressTaken(IDEAS)).toBe(false);
  expect(t.drag.pressTaken(RECIPES)).toBe(true);
  expect(t.drag.pressTaken(RECIPES)).toBe(false);
  await t.lift();
  t.drag.touch.end();
  t.timers.advance(1000);
  expect(t.drag.pressTaken(RECIPES)).toBe(false);
  // A tap: down and up before the hold.
  t.drag.touch.start(RECIPES, recipes, AT_RECIPES);
  t.timers.advance(120);
  t.drag.touch.end();
  t.timers.advance(TOPIC_HOLD_MS);
  await settle();
  expect(t.drag.lifted(RECIPES)).toBe(false);
  expect(t.drag.pressTaken(RECIPES)).toBe(false);
});

test("a gesture the system takes and a cancelled touch drop nothing", async () => {
  const t = setup();
  // Taken from the responder over travel (the system's back gesture, a dialog).
  await t.lift();
  t.drag.touch.grant(AT_RECIPES);
  t.drag.touch.follow(OVER_TRAVEL);
  expect(t.zones()["tag:travel"]).toBe("over");
  t.drag.touch.terminate();
  expect(t.drag.lifted(RECIPES)).toBe(false);
  expect(t.zones()["tag:travel"]).toBe("none");
  t.drag.touch.release(OVER_TRAVEL);
  await settle();
  // Cancelled while lifted, before the row took the gesture.
  await t.lift();
  t.drag.touch.end();
  expect(t.drag.lifted(RECIPES)).toBe(false);
  // While the row is the responder a touch's end is its release: the cancel alone changes nothing,
  // the termination after it ends the drag.
  await t.lift();
  t.drag.touch.grant(AT_RECIPES);
  t.drag.touch.follow(OVER_TRAVEL);
  t.drag.touch.end();
  expect(t.zones()["tag:travel"]).toBe("over");
  t.drag.touch.terminate();
  expect(t.zones()["tag:travel"]).toBe("none");
  await settle();
  expect(t.drops).toEqual([]);
});

test("a group the topic cannot go to, and a drop outside the groups, drop nothing", async () => {
  const t = setup();
  const dragTo = async (to: { x: number; y: number }, rowKey = RECIPES, topic: any = recipes) => {
    await t.lift(rowKey, topic);
    t.drag.touch.grant(AT_RECIPES);
    t.drag.touch.follow(to);
    const state = t.zones();
    t.drag.touch.release(to);
    await settle();
    return state;
  };
  // Its own group (a tag it has), the pinned group, the untagged group.
  expect(await dragTo({ x: 100, y: 200 })).toEqual({ pinned: "none", "tag:food": "none", "tag:travel": "target", "tag:": "none" });
  expect((await dragTo({ x: 100, y: 140 })).pinned).toBe("none");
  expect((await dragTo({ x: 100, y: 380 }))["tag:"]).toBe("none");
  // Beside the list, and past its last row.
  expect((await dragTo({ x: 400, y: 290 }))["tag:travel"]).toBe("target");
  expect((await dragTo({ x: 100, y: 420 }))["tag:travel"]).toBe("target");
  // Soups has both tags: no group to go to at all, nothing outlined.
  expect(Object.values(await dragTo(OVER_TRAVEL, "topic:tag:travel:soups", soups))).toEqual(["none", "none", "none", "none"]);
  expect(t.drops).toEqual([]);
  // A duplicate drop is no drop: Recipes once on travel, then again with the tag it now has.
  await dragTo(OVER_TRAVEL);
  expect(t.drops).toEqual([["recipes", "tag:travel"]]);
  recipes.tags = ["food", "travel"];
  try {
    await dragTo(OVER_TRAVEL);
  } finally {
    recipes.tags = ["food"];
  }
  expect(t.drops).toEqual([["recipes", "tag:travel"]]);
});

test("an empty list, or one whose place is not measured, drops nothing", async () => {
  const empty = setup({ rows: [] });
  await empty.lift();
  empty.drag.touch.grant(AT_RECIPES);
  empty.drag.touch.follow(OVER_TRAVEL);
  empty.drag.touch.release(OVER_TRAVEL);
  await settle();
  expect(empty.drops).toEqual([]);
  const unmeasured = setup({ measured: false });
  await unmeasured.lift();
  expect(unmeasured.zones()["tag:travel"]).toBe("target");
  unmeasured.drag.touch.grant(AT_RECIPES);
  unmeasured.drag.touch.follow(OVER_TRAVEL);
  expect(unmeasured.zones()["tag:travel"]).toBe("target");
  unmeasured.drag.touch.release(OVER_TRAVEL);
  await settle();
  expect(unmeasured.drops).toEqual([]);
});

test("the tag view going ends a hold or a drag; it never starts one elsewhere", async () => {
  const t = setup();
  // Mid-drag.
  await t.lift();
  t.drag.touch.grant(AT_RECIPES);
  t.drag.touch.follow(OVER_TRAVEL);
  t.enabled.set(false);
  await settle();
  expect(t.drag.lifted(RECIPES)).toBe(false);
  expect(t.zones()["tag:travel"]).toBe("none");
  t.drag.touch.release(OVER_TRAVEL);
  await settle();
  // While the finger waits.
  t.enabled.set(true);
  await settle();
  t.drag.touch.start(RECIPES, recipes, AT_RECIPES);
  t.enabled.set(false);
  await settle();
  t.timers.advance(TOPIC_HOLD_MS);
  await settle();
  expect(t.drag.lifted(RECIPES)).toBe(false);
  // Not in the tag view at all.
  t.drag.touch.start(RECIPES, recipes, AT_RECIPES);
  t.timers.advance(TOPIC_HOLD_MS);
  await settle();
  expect(t.drag.lifted(RECIPES)).toBe(false);
  expect(t.drag.touch.claims(RECIPES)).toBe(false);
  expect(t.drops).toEqual([]);
});

test("a second finger during the hold ends it; one during a drag leaves the drag", async () => {
  const t = setup();
  t.drag.touch.start(RECIPES, recipes, AT_RECIPES);
  t.drag.touch.start(IDEAS, ideas, { x: 100, y: 380 }, 2);
  t.timers.advance(TOPIC_HOLD_MS);
  await settle();
  expect(t.drag.lifted(RECIPES)).toBe(false);
  expect(t.drag.lifted(IDEAS)).toBe(false);
  await t.lift();
  t.drag.touch.grant(AT_RECIPES);
  t.drag.touch.start(IDEAS, ideas, { x: 100, y: 380 }, 2);
  t.drag.touch.follow(OVER_TRAVEL);
  t.drag.touch.release(OVER_TRAVEL);
  await settle();
  expect(t.drops).toEqual([["recipes", "tag:travel"]]);
});

// The app on a headless Android phone: a finger resting on a topic in the tag view.

const NOW = new Date().toISOString();
const TAG_VIEW = { "mistermorph.chat.topicSidebarView": "tags" };
const TOPICS = [
  { id: "topic-1", title: "Trip plans", created_at: NOW, updated_at: NOW, tags: ["pinned", "travel"] },
  { id: "topic-2", title: "Recipes", created_at: NOW, updated_at: NOW, tags: ["food"] },
  { id: "topic-3", title: "Soups", created_at: NOW, updated_at: NOW, tags: ["food", "travel"] },
  { id: "topic-4", title: "Ideas", created_at: NOW, updated_at: NOW, tags: [] },
];

function tagPuts(calls: ApiRequest[]) {
  return calls.filter((call) => call.method === "PUT" && /\/topics\/[^/]+\/tags$/.test(call.uri || ""));
}

async function phoneTagView() {
  const opened = await openConsole({
    platform: "android",
    location: "/e/default/chat",
    kv: TAG_VIEW,
    api: {
      "GET /proxy:/topics": { body: { items: TOPICS } },
      "GET /proxy:/tasks": { body: { items: [] } },
    },
  });
  await opened.app.waitFor("id:chat-topic-group-tag:travel");
  return opened;
}

const opened = (calls: ApiRequest[], id: string) => calls.some((call) => call.uri?.includes(`topic_id=${id}`));

test("on a phone a finger resting on a topic lifts it and outlines its groups; letting go opens and saves nothing", async () => {
  const { app, calls } = await phoneTagView();
  // Down on Recipes, 2pt of tremble, and a rest: nothing before the hold...
  await app.dragAndHold("id:chat-topic-row-topic-2", { x: 0, y: 2 });
  expect(app.count("id:chat-topic-drop-target-tag:travel")).toBe(0);
  // ...then the groups it can go to are outlined (travel only).
  await app.wait(TOPIC_HOLD_MS + 150);
  await app.waitFor("id:chat-topic-drop-target-tag:travel");
  expect(app.count("id:chat-topic-drop-target-tag:food")).toBe(0);
  expect(app.count("id:chat-topic-drop-target-pinned")).toBe(0);
  expect(app.count("id:chat-topic-drop-target-tag:")).toBe(0);
  await app.drop();
  await app.waitFor("id:chat-topic-drop-target-tag:travel", { state: "gone" });
  await app.wait(100);
  expect(tagPuts(calls)).toHaveLength(0);
  // (Headless, the end of a held drag presses nothing at all: that the hold takes the press that
  // Android sends is checked on the module above.)
  expect(opened(calls, "topic-2")).toBe(false);
  // A tap still opens a topic (the Topic panel's tag editor is there).
  await app.press("id:chat-topic-topic-2");
  await app.waitUntil(() => opened(calls, "topic-2"));
});

test("on a phone a swipe on a topic scrolls and lifts nothing, even when the finger then rests", async () => {
  const { app, calls } = await phoneTagView();
  await app.dragAndHold("id:chat-topic-row-topic-2", { x: 0, y: 60 });
  await app.wait(TOPIC_HOLD_MS + 150);
  expect(app.count("id:chat-topic-drop-target-tag:travel")).toBe(0);
  await app.drop();
  await app.wait(100);
  expect(tagPuts(calls)).toHaveLength(0);
});

test("on a phone the date view lifts nothing", async () => {
  const { app, calls } = await phoneTagView();
  await app.press("id:chat-topics-view-tags");
  await app.waitFor("TODAY");
  await app.dragAndHold("id:chat-topic-row-topic-4", { x: 0, y: 2 });
  await app.wait(TOPIC_HOLD_MS + 150);
  expect(app.count("id:chat-topic-drop-target-tag:travel")).toBe(0);
  await app.drop();
  await app.wait(100);
  expect(tagPuts(calls)).toHaveLength(0);
});
