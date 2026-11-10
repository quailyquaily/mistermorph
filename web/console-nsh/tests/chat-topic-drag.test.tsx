// Dragging a topic onto a tag group in the topic list's tag view (desktops): the drop adds the
// group's tag to the topic's own and saves it; a duplicate, the pinned and untagged groups, a drop
// outside the list, Escape and the date view change nothing; a failed save says why and keeps the
// tags. On a touch phone a drag scrolls the list and tags nothing.
//
// The tag view here (1280 × 800, rows 40pt 2pt apart, headings 29.4pt 6pt apart):
//   Pinned   · Trip plans          (pinned, travel)
//   food     · Soups · Recipes     (food, travel) · (food)
//   travel   · Soups · Trip plans
//   Untagged · Ideas               (none)
// so 80pt down from Recipes is travel, and 80pt up from Ideas is travel's Trip plans.
import { expect, test } from "nsh/test";
import { openConsole, type ApiRequest } from "./harness";
import { topicDropZoneAt, topicDropZones } from "../pages/chat/topicDrag";
import type { TopicRow } from "../pages/chat/chatController";

const NOW = new Date().toISOString();
const TAG_VIEW = { "mistermorph.chat.topicSidebarView": "tags" };

function topic(id: string, title: string, tags: string[] = []) {
  return { id, title, created_at: NOW, updated_at: NOW, tags };
}

const TOPICS = [
  topic("topic-1", "Trip plans", ["pinned", "travel"]),
  topic("topic-2", "Recipes", ["food"]),
  topic("topic-3", "Soups", ["food", "travel"]),
  topic("topic-4", "Ideas"),
];

function tagPuts(calls: ApiRequest[]) {
  return calls.filter((call) => call.method === "PUT" && /\/topics\/[^/]+\/tags$/.test(call.uri || ""));
}

async function tagView(options: { fail?: boolean } = {}) {
  const items = TOPICS.map((item) => ({ ...item, tags: [...item.tags] }));
  const opened = await openConsole({
    location: "/e/default/chat",
    kv: TAG_VIEW,
    api: {
      "GET /proxy:/topics": () => ({ body: { items } }),
      "GET /proxy:/tasks": { body: { items: [] } },
      ...Object.fromEntries(
        items.map((item) => [
          `PUT /proxy:/topics/${item.id}/tags`,
          (request: ApiRequest) => {
            if (options.fail) return { status: 500, body: { error: "tags store is down" } };
            item.tags = [...request.json.tags];
            return { body: item };
          },
        ]),
      ),
    },
  });
  await opened.app.waitFor("id:chat-topic-group-tag:food");
  await opened.app.waitFor("id:chat-topic-group-tag:travel");
  return opened;
}

test("the drop zones run from a group's heading to the next one's, the last to its last row", () => {
  const frame = (y: number, height: number) => ({ origin: { x: 16, y }, size: { width: 200, height } });
  const food = { key: "tag:food", drop: { kind: "tag", tag: "food" } };
  const travel = { key: "tag:travel", drop: { kind: "tag", tag: "travel" } };
  const rows: TopicRow[] = [
    { kind: "note", key: "note:tags", text: "" },
    { kind: "group", key: "group:tag:food", group: food, collapsible: true, collapsed: false },
    { kind: "topic", key: "topic:tag:food:a", topic: { id: "a" }, group: food },
    { kind: "group", key: "group:tag:travel", group: travel, collapsible: true, collapsed: false },
    { kind: "topic", key: "topic:tag:travel:b", topic: { id: "b" }, group: travel },
    { kind: "topic", key: "topic:tag:travel:c", topic: { id: "c" }, group: travel },
  ];
  const frames = new Map([
    ["note:tags", frame(0, 30)],
    ["group:tag:food", frame(36, 30)],
    ["topic:tag:food:a", frame(68, 40)],
    ["group:tag:travel", frame(114, 30)],
    ["topic:tag:travel:b", frame(146, 40)],
    ["topic:tag:travel:c", frame(188, 40)],
  ]);
  const zones = topicDropZones(rows, frames);
  expect(zones.map((zone) => [zone.key, zone.y, zone.height])).toEqual([
    ["tag:food", 36, 78],
    ["tag:travel", 114, 114],
  ]);
  expect(topicDropZoneAt(zones, { x: 100, y: 20 })).toBe(null);
  expect(topicDropZoneAt(zones, { x: 100, y: 110 })?.key).toBe("tag:food");
  expect(topicDropZoneAt(zones, { x: 100, y: 114 })?.key).toBe("tag:travel");
  expect(topicDropZoneAt(zones, { x: 100, y: 227 })?.key).toBe("tag:travel");
  expect(topicDropZoneAt(zones, { x: 100, y: 229 })).toBe(null);
  expect(topicDropZoneAt(zones, { x: 400, y: 150 })).toBe(null);
  expect(topicDropZoneAt(zones, null)).toBe(null);
  // A row not laid out yet is left out; a folded group is its heading alone.
  expect(topicDropZones(rows.slice(0, 4), frames).map((zone) => [zone.key, zone.height])).toEqual([
    ["tag:food", 78],
    ["tag:travel", 30],
  ]);
  expect(topicDropZones(rows, new Map())).toEqual([]);
});

test("dropping a topic on a tag group adds the tag, keeps its other tags and moves it there", async () => {
  const { app, calls } = await tagView();
  // Recipes (food) down onto travel: while held, the groups it can go to are outlined (travel
  // only: not its own food group, not the pinned or untagged groups) and travel is filled.
  await app.dragAndHold("id:chat-topic-row-topic-2", { x: 0, y: 80 });
  await app.waitFor("id:chat-topic-drop-over-tag:travel");
  expect(app.shows("id:chat-topic-drop-target-tag:food")).toBe(false);
  expect(app.shows("id:chat-topic-drop-over-tag:food")).toBe(false);
  expect(app.shows("id:chat-topic-drop-target-pinned")).toBe(false);
  expect(app.shows("id:chat-topic-drop-target-tag:")).toBe(false);
  expect(tagPuts(calls)).toHaveLength(0);
  await app.drop();
  await app.waitUntil(() => tagPuts(calls).length === 1);
  const put = tagPuts(calls)[0];
  expect(put.uri).toBe("/topics/topic-2/tags");
  expect(put.json).toEqual({ tags: ["food", "travel"] });
  // The outlines go, the topic is listed under travel too, and the drag opened nothing.
  await app.waitFor("id:chat-topic-drop-over-tag:travel", { state: "gone" });
  await app.waitUntil(() => app.count("id:chat-topic-topic-2") === 2);
  expect(calls.some((call) => call.uri?.includes("topic_id=topic-2"))).toBe(false);
  // A press still opens a topic.
  await app.press("id:chat-topic-topic-4");
  await app.waitUntil(() => calls.some((call) => call.uri?.includes("topic_id=topic-4")));
});

test("an untagged topic dropped on a tag leaves the untagged group", async () => {
  const { app, calls } = await tagView();
  // Ideas, the untagged group's only topic, up onto travel's Soups row.
  await app.dragAndHold("id:chat-topic-row-topic-4", { x: 0, y: -80 });
  await app.waitFor("id:chat-topic-drop-over-tag:travel");
  // Every tag group is a target for a topic with no tags.
  expect(app.shows("id:chat-topic-drop-target-tag:food")).toBe(true);
  await app.drop();
  await app.waitUntil(() => tagPuts(calls).length === 1);
  expect(tagPuts(calls)[0].json).toEqual({ tags: ["travel"] });
  await app.waitFor("id:chat-topic-group-tag:", { state: "gone" });
});

test("a tag the topic has, the pinned and untagged groups and a drop outside the list save nothing", async () => {
  const { app, calls } = await tagView();
  // Soups (food, travel) from food down onto travel, which it has: no target at all.
  await app.dragAndHold("id:chat-topic-row-topic-3 >> nth=0", { x: 0, y: 80 });
  await app.wait(50);
  expect(app.shows("id:chat-topic-drop-over-tag:travel")).toBe(false);
  expect(app.shows("id:chat-topic-drop-target-tag:travel")).toBe(false);
  await app.drop();
  // Recipes up onto the pinned group: not a target (the pin is the Topic panel's).
  await app.dragAndHold("id:chat-topic-row-topic-2", { x: 0, y: -100 });
  await app.wait(50);
  expect(app.shows("id:chat-topic-drop-over-pinned")).toBe(false);
  await app.drop();
  // Recipes down onto the untagged group: not a target either (it would clear its tags).
  await app.dragAndHold("id:chat-topic-row-topic-2", { x: 0, y: 170 });
  await app.wait(50);
  expect(app.shows("id:chat-topic-drop-over-tag:")).toBe(false);
  await app.drop();
  // Ideas over travel, then out of the sidebar into the chat before letting go.
  await app.dragAndHold("id:chat-topic-row-topic-4", { x: 0, y: -80 });
  await app.waitFor("id:chat-topic-drop-over-tag:travel");
  await app.drop();
  await app.waitUntil(() => tagPuts(calls).length === 1);
  await app.dragAndHold("id:chat-topic-row-topic-2", { x: 600, y: 80 });
  await app.wait(50);
  expect(app.shows("id:chat-topic-drop-over-tag:travel")).toBe(false);
  await app.drop();
  await app.wait(100);
  expect(tagPuts(calls)).toHaveLength(1);
  expect(tagPuts(calls)[0].uri).toBe("/topics/topic-4/tags");
});

test("Escape cancels a drag, and the date view drags nothing", async () => {
  const { app, calls } = await tagView();
  await app.dragAndHold("id:chat-topic-row-topic-2", { x: 0, y: 80 });
  await app.waitFor("id:chat-topic-drop-over-tag:travel");
  await app.keyboard.press("escape");
  await app.waitFor("id:chat-topic-drop-over-tag:travel", { state: "gone" });
  await app.drop();
  await app.wait(100);
  expect(tagPuts(calls)).toHaveLength(0);
  // The date view has no tag groups to drop on.
  await app.press("id:chat-topics-view-tags");
  await app.waitFor("TODAY");
  await app.dragAndHold("id:chat-topic-row-topic-4", { x: 0, y: -80 });
  await app.wait(50);
  expect(app.count("id:chat-topic-drop-target-tag:travel")).toBe(0);
  await app.drop();
  await app.wait(100);
  expect(tagPuts(calls)).toHaveLength(0);
});

test("a drop that fails to save says why and keeps the topic's tags", async () => {
  const { app, calls } = await tagView({ fail: true });
  await app.dragAndHold("id:chat-topic-row-topic-2", { x: 0, y: 80 });
  await app.waitFor("id:chat-topic-drop-over-tag:travel");
  await app.drop();
  await app.waitUntil(() => tagPuts(calls).length === 1);
  await app.waitFor("tags store is down");
  // Recipes is still only under food.
  expect(app.count("id:chat-topic-topic-2")).toBe(1);
  // And it can be dropped again once that save is over.
  await app.dragAndHold("id:chat-topic-row-topic-2", { x: 0, y: 80 });
  await app.waitFor("id:chat-topic-drop-over-tag:travel");
  await app.drop();
  await app.waitUntil(() => tagPuts(calls).length === 2);
});

test("on a touch phone a drag on a topic scrolls the list and tags nothing", async () => {
  const { app, calls } = await openConsole({
    platform: "android",
    location: "/e/default/chat",
    kv: TAG_VIEW,
    api: {
      "GET /proxy:/topics": { body: { items: TOPICS } },
      "GET /proxy:/tasks": { body: { items: [] } },
    },
  });
  await app.waitFor("id:chat-topic-group-tag:travel");
  await app.dragAndHold("id:chat-topic-row-topic-2", { x: 0, y: 80 });
  await app.wait(50);
  expect(app.count("id:chat-topic-drop-over-tag:travel")).toBe(0);
  expect(app.count("id:chat-topic-drop-target-tag:travel")).toBe(0);
  await app.drop();
  await app.wait(100);
  expect(tagPuts(calls)).toHaveLength(0);
  // A tap opens the topic, where its Topic panel tags it.
  await app.press("id:chat-topic-topic-2");
  await app.waitUntil(() => calls.some((call) => call.uri?.includes("topic_id=topic-2")));
});
