import assert from "node:assert/strict";
import test from "node:test";

import { placeSteeredAgentsAfterUsers } from "./chat-history-steering.js";

test("places a target agent after its steering user across history pages", () => {
  const items = [
    { id: "target:user", role: "user" },
    { id: "target:agent", role: "agent", taskId: "target" },
    {
      id: "steer:user",
      role: "user",
      steerTargetTaskID: "target",
    },
  ];

  assert.deepEqual(
    placeSteeredAgentsAfterUsers(items).map((item) => item.id),
    ["target:user", "steer:user", "target:agent"]
  );
});

test("places a target agent after the reply to its steering message", () => {
  const items = [
    { id: "target:user", role: "user" },
    { id: "target:agent", role: "agent", taskId: "target" },
    { id: "steer1:user", role: "user", steerTargetTaskID: "target" },
    { id: "steer1:agent", role: "agent", taskId: "steer1" },
    { id: "steer2:user", role: "user", steerTargetTaskID: "target" },
    { id: "steer2:agent", role: "agent", taskId: "steer2" },
  ];

  assert.deepEqual(
    placeSteeredAgentsAfterUsers(items).map((item) => item.id),
    ["target:user", "steer1:user", "steer1:agent", "steer2:user", "steer2:agent", "target:agent"]
  );
});

test("places a target agent after a live steering message's reply", () => {
  const items = [
    { id: "h1", role: "user" },
    { id: "h2", role: "agent", taskId: "target" },
    { id: "h3", role: "user", taskId: "steer", steerTargetTaskID: "target" },
    { id: "h4", role: "agent", taskId: "steer" },
  ];

  assert.deepEqual(
    placeSteeredAgentsAfterUsers(items).map((item) => item.id),
    ["h1", "h3", "h4", "h2"]
  );
});
