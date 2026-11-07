import assert from "node:assert/strict";
import test from "node:test";

import { arrangeTopicGroups, moveGroupTopic, moveTagGroup, orderGroupTopics } from "./topic-layout.js";

const t = (id) => ({ id });
const groups = () => [
  { key: "pinned", pinned: true, topics: [t("p1"), t("p2")] },
  { key: "tag:a", topics: [t("1"), t("2"), t("3")] },
  { key: "tag:b", topics: [t("4")] },
  { key: "tag:c", topics: [t("5")] },
  { key: "tag:", untagged: true, topics: [t("6")] },
];
const keys = (list) => list.map((group) => group.key);
const ids = (topics) => topics.map((topic) => topic.id);

test("the layout orders tag groups and topics; pinned stays first and untagged last", () => {
  const arranged = arrangeTopicGroups(groups(), {
    tag_order: ["tag:c", "tag:gone", "tag:a"],
    topic_order: { "tag:a": ["3", "1"], pinned: ["p2"] },
  });
  assert.deepEqual(keys(arranged), ["pinned", "tag:c", "tag:a", "tag:b", "tag:"]);
  assert.deepEqual(ids(arranged[2].topics), ["2", "3", "1"]);
  assert.deepEqual(ids(arranged[0].topics), ["p1", "p2"]);
  assert.deepEqual(keys(arrangeTopicGroups(groups(), null)), ["pinned", "tag:a", "tag:b", "tag:c", "tag:"]);
});

test("topics new to a group come first", () => {
  assert.deepEqual(ids(orderGroupTopics([t("new"), t("x"), t("y")], ["y", "x"])), ["new", "y", "x"]);
});

test("moving a tag group keeps arranged groups that are not shown", () => {
  const next = moveTagGroup({ tag_order: ["tag:hidden"] }, ["tag:a", "tag:b", "tag:c"], "tag:c", "tag:a", false);
  assert.deepEqual(next.tag_order, ["tag:c", "tag:a", "tag:b", "tag:hidden"]);
  assert.deepEqual(moveTagGroup(null, ["tag:a", "tag:b"], "tag:a", "tag:b", true).tag_order, ["tag:b", "tag:a"]);
  assert.equal(moveTagGroup(null, ["tag:a"], "tag:a", "tag:a", false), null);
});

test("moving a topic within a group, or into one from elsewhere", () => {
  const within = moveGroupTopic({ topic_order: { "tag:a": ["unloaded"] } }, "tag:a", ["1", "2", "3"], "3", "1", false);
  assert.deepEqual(within.topic_order["tag:a"], ["3", "1", "2", "unloaded"]);
  const into = moveGroupTopic(null, "tag:b", ["4"], "9", "4", true);
  assert.deepEqual(into.topic_order["tag:b"], ["4", "9"]);
  const atEnd = moveGroupTopic(null, "tag:b", ["4", "5"], "4", null, false);
  assert.deepEqual(atEnd.topic_order["tag:b"], ["5", "4"]);
});
