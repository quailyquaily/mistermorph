import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { applyUserReaction, taskAgentText, taskListHistoryItems } from "./chat-task-history.js";

const t = (key) => key;
const tasks = [
  { id: "origin", topic_id: "a", task: "First", status: "done", created_at: "2026-11-03T00:00:00Z", result: { final: { output: "", is_lightweight: true } } },
  { id: "later", topic_id: "a", task: "Second", status: "running", created_at: "2026-11-03T00:00:01Z" },
];

test("reactions reload on the originating user bubble with no emoji reply", () => {
  const initial = taskListHistoryItems(tasks, t, { endpointRef: "local" });
  assert.equal(initial[0].reaction, "");
  const items = taskListHistoryItems([{ ...tasks[0], user_reaction: "👍" }, tasks[1]], t, { endpointRef: "local" });
  assert.equal(items.length, initial.length);
  assert.equal(items[0].reaction, "👍");
  assert.equal(items[1].text, "");
  assert.equal(items[2].reaction, "");
  assert.equal(items.filter((item) => item.role === "agent" && item.text === "👍").length, 0);
  assert.equal(taskAgentText({ ...tasks[0], user_reaction: "👍", result: { final: { output: "Real reply" } } }, t), "Real reply");
  assert.equal(taskAgentText({ ...tasks[0], user_reaction: "👍", status: "failed", error: "Failed" }, t), "Failed");
  assert.equal(taskAgentText(tasks[0], t), "chat_result_empty");
});

test("live updates replace one badge by task identity, including optimistic message IDs", () => {
  let items = taskListHistoryItems(tasks, t, { endpointRef: "local" });
  items[0].id = "optimistic-user";
  items[0].taskId = "origin";
  items.push({ ...items[0], id: "other-endpoint", endpointRef: "remote", reaction: "" });
  for (const emoji of ["👍", "👍", "❤️"]) {
    const previous = items;
    const previousReaction = items[0].reaction;
    items = applyUserReaction(items, "origin", emoji, "local");
    assert.equal(previous[0].reaction, previousReaction, "shallowRef items must not be mutated");
    if (previousReaction !== emoji) assert.notEqual(items[0], previous[0]);
    assert.equal(items.length, 5);
    assert.equal(items[0].reaction, emoji);
    assert.equal(items[2].reaction, "");
    assert.equal(items[4].reaction, "");
    assert.equal(items[1].reaction, undefined);
  }
  items = applyUserReaction(items, "missing", "😎", "local");
  items = applyUserReaction(items, "origin", undefined, "local");
  assert.equal(items[0].reaction, "❤️");
  let reload = taskListHistoryItems([{ ...tasks[0], user_reaction: "❤️" }], t, { endpointRef: "local" });
  reload = applyUserReaction(reload, "origin", "🎉", "local");
  assert.equal(reload[0].reaction, "🎉");
});

test("stream and polling update user reactions; badge is conditional and outside message content", async () => {
  const chat = await readFile(new URL("../views/ChatView.js", import.meta.url), "utf8");
  const item = await readFile(new URL("../components/ChatHistoryItem.js", import.meta.url), "utf8");
  assert.match(chat, /replaceHistoryItems\(applyUserReaction\(chatHistoryItems\.value, key, frame\.user_reaction, endpointRef\)/u);
  assert.match(chat, /replaceHistoryItems\(applyUserReaction\(chatHistoryItems\.value, key, detail\?\.user_reaction, endpointRef\)/u);
  assert.match(item, /v-if="role === 'user' && item\.reaction"/u);
  assert.match(item, /class="chat-history-reaction"[^>]*>\{\{ item\.reaction \}\}<\/span>/u);
  assert.match(item, /agentBubbleVisible[\s\S]*String\(props\.item\?\.text \|\| ""\) !== ""/u);
});
