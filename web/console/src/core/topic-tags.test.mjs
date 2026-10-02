import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  groupTopicsByTag,
  knownTopicTags,
  mergeTopicTags,
  ordinaryTopicTags,
  parseTopicTagInput,
  sameTopicTags,
  splitPinnedTopics,
  suggestTopicTags,
  tagsAfterDrop,
  topicPinned,
  topicTags,
  withPinned,
} from "./topic-tags.js";

test("tags are cleaned and deduplicated like the server does", () => {
  assert.deepEqual(topicTags({ tags: [" Deep   work ", "deep work", "", "研究"] }), ["Deep work", "研究"]);
  assert.deepEqual(mergeTopicTags(["Work"], ["work", "Ideas", "x".repeat(40)]), ["Work", "Ideas", "x".repeat(32)]);
  assert.deepEqual(parseTopicTagInput("a, b，c、 ,d"), ["a", "b", "c", "d"]);
  assert.ok(sameTopicTags(["A", "b"], ["A", " b "]));
  assert.ok(!sameTopicTags(["A", "b"], ["b", "A"]));
});

test("pinned is a reserved tag kept apart from the ordinary ones", () => {
  const topic = { tags: ["Work", " PINNED "] };
  assert.ok(topicPinned(topic));
  assert.deepEqual(topicTags(topic), ["Work", "pinned"]);
  assert.deepEqual(ordinaryTopicTags(topic), ["Work"]);
  assert.deepEqual(withPinned(["Work"], true), ["pinned", "Work"]);
  assert.deepEqual(withPinned(["Work", "pinned"], false), ["Work"]);
});

test("the tag view lists pinned topics first, then tags, then untagged topics", () => {
  const topics = [
    { id: "1", tags: ["work", "Ideas"] },
    { id: "2" },
    { id: "3", tags: ["Work", "pinned"] },
    { id: "4", tags: ["10 later", "2 soon"] },
    { id: "5", tags: ["pinned"] },
  ];
  const groups = groupTopicsByTag(topics, { pinned: "Pinned", untagged: "Untagged" });
  assert.deepEqual(
    groups.map((group) => [group.label, group.topics.map((topic) => topic.id)]),
    [
      ["Pinned", ["3", "5"]],
      ["2 soon", ["4"]],
      ["10 later", ["4"]],
      ["Ideas", ["1"]],
      ["work", ["1", "3"]],
      ["Untagged", ["2"]],
    ],
  );
  assert.deepEqual(groups[0].drop, { kind: "pin" });
  assert.deepEqual(groups.at(-1).drop, { kind: "untagged" });
  assert.deepEqual(knownTopicTags(topics), ["2 soon", "10 later", "Ideas", "work"]);
  const { pinned, rest } = splitPinnedTopics(topics);
  assert.deepEqual(pinned.map((topic) => topic.id), ["3", "5"]);
  assert.deepEqual(rest.map((topic) => topic.id), ["1", "2", "4"]);
});

test("dropping a topic on a group tags, pins or untags it", () => {
  const topic = { tags: ["pinned", "Work"] };
  assert.deepEqual(tagsAfterDrop(topic, { kind: "tag", tag: "Ideas" }), ["pinned", "Work", "Ideas"]);
  assert.deepEqual(tagsAfterDrop(topic, { kind: "untagged" }), ["pinned"]);
  assert.equal(tagsAfterDrop(topic, { kind: "tag", tag: "work" }), null);
  assert.equal(tagsAfterDrop(topic, { kind: "pin" }), null);
  assert.deepEqual(tagsAfterDrop({ tags: ["Work"] }, { kind: "pin" }), ["pinned", "Work"]);
  const full = { tags: ["pinned", "1", "2", "3", "4", "5"] };
  assert.equal(tagsAfterDrop(full, { kind: "tag", tag: "6" }), null);
});

test("suggestions put tags starting with the typed text first", () => {
  const known = ["Archive", "Research", "Search", "Work"];
  assert.deepEqual(suggestTopicTags(known, ["Work"], "se"), ["Search", "Research"]);
  assert.deepEqual(suggestTopicTags(known, ["Work"], ""), ["Archive", "Research", "Search"]);
  assert.deepEqual(suggestTopicTags(["pinned", "a"], [], ""), ["a"]);
});

test("ChatView watches the topic only after declaring it", async () => {
  const source = await readFile(new URL("../views/ChatView.js", import.meta.url), "utf8");
  const declared = source.indexOf("const workspaceTopicID = computed(");
  const watched = source.indexOf("watch(workspaceTopicID,");
  assert.ok(declared > 0 && watched > declared, "watch(workspaceTopicID) runs before workspaceTopicID exists");
});
