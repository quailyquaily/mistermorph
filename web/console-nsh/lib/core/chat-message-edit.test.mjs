import assert from "node:assert/strict";
import test from "node:test";
import { editableMessage, editQuoteLine, editReplacedItemIDs, historyBeforeEdit, historyItemTaskID, isCommandMessage } from "./chat-message-edit.js";

test("a row's task comes from taskId or from a loaded row's id", () => {
  assert.equal(historyItemTaskID({ role: "user", id: "h1", taskId: "t9" }), "t9");
  assert.equal(historyItemTaskID({ role: "user", id: "t3:user" }), "t3");
  assert.equal(historyItemTaskID({ role: "agent", id: "t3:user" }), "");
  assert.equal(historyItemTaskID({ role: "user", id: "h1" }), "");
});

test("commands are not messages, /think is", () => {
  for (const command of ["/reset", "/model gpt", "/Compact", "/help@bot"]) assert.equal(isCommandMessage(command), true, command);
  for (const message of ["/think why?", "hello /reset", "  plain", "/", ""]) assert.equal(isCommandMessage(message), false, message);
});

test("only a sent message with text and a task can be edited", () => {
  assert.equal(editableMessage({ role: "user", id: "t1:user", text: "hi" }), true);
  assert.equal(editableMessage({ role: "user", id: "h2", taskId: "t2", text: "hi" }), true);
  assert.equal(editableMessage({ role: "user", id: "h3", text: "not sent yet" }), false);
  assert.equal(editableMessage({ role: "user", id: "t4:user", text: "   " }), false);
  assert.equal(editableMessage({ role: "user", id: "t5:user", text: "/reset" }), false);
  assert.equal(editableMessage({ role: "agent", id: "t1:agent", text: "reply" }), false);
});

test("an edit replaces its message and everything after it", () => {
  const items = [
    { id: "t1:user", role: "user" },
    { id: "t1:agent", role: "agent" },
    { id: "h2", role: "user", taskId: "t2" },
    { id: "t2:agent", role: "agent" },
    { id: "t3:user", role: "user" },
    { id: "t3:agent", role: "agent" },
  ];
  assert.deepEqual([...editReplacedItemIDs(items, { itemID: "h2", taskID: "t2" })], ["h2", "t2:agent", "t3:user", "t3:agent"]);
  assert.deepEqual(historyBeforeEdit(items, { itemID: "t3:user", taskID: "t3" }).map((item) => item.id), ["t1:user", "t1:agent", "h2", "t2:agent"]);
  // A reload renamed the row: the task still finds it.
  assert.deepEqual(historyBeforeEdit(items, { itemID: "gone", taskID: "t2" }).map((item) => item.id), ["t1:user", "t1:agent"]);
  assert.equal(historyBeforeEdit(items, { itemID: "gone", taskID: "t9" }), null);
  assert.equal(editReplacedItemIDs(items, null).size, 0);
});

test("the quote is one line", () => {
  assert.equal(editQuoteLine("  first line\n\nsecond\tline  "), "first line second line");
});
