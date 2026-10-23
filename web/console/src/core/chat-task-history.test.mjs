import assert from "node:assert/strict";
import test from "node:test";

import {
  isTerminalStatus,
  mergeRefreshedHistoryItems,
  normalizeTaskStatus,
  normalizeActivity,
  normalizePlan,
  normalizeQuestions,
  keepLiveTaskState,
  taskAgentText,
  taskListHistoryItems,
  planStepMessages,
  agentLinkMessages,
} from "./chat-task-history.js";

test("normalizeActivity retains separate retry notices with their reasons", () => {
  const activity = normalizeActivity({ history: [
    { id: "retry:1", kind: "retry", name: "model", status: "done", summary: "HTTP 504 · retry 1/5" },
    { id: "retry:2", kind: "retry", name: "model", status: "done", summary: "HTTP 504 · retry 2/5" },
  ] });
  assert.equal(activity?.history.length, 2);
  assert.equal(activity.current.id, "retry:2");
  assert.equal(activity.current.summary, "HTTP 504 · retry 2/5");
});

function t(key, vars = {}) {
  const messages = {
    chat_approval_waiting_text: "Waiting for approval.",
    chat_approval_denied: "Denied.",
    chat_approval_expired: "Expired.",
    chat_result_empty: "No output.",
    chat_polling_hint: `${vars.name || "Agent"} is working...`,
    chat_agent_name_fallback: "Agent",
  };
  return messages[key] || key;
}

test("taskListHistoryItems builds reusable endpoint-scoped chat items", () => {
  const items = taskListHistoryItems(
    [
      {
        id: "task_2",
        topic_id: "topic_b",
        task: "Second",
        status: "done",
        created_at: "2026-08-14T02:00:00Z",
        started_at: "2026-08-14T02:00:01Z",
        finished_at: "2026-08-14T02:00:03Z",
        result: {
          final: { output: "Done" },
          reasoning: "Checked both sources.",
          plan: { steps: [{ step: "Check", status: "completed" }] },
          activity: {
            history: [{ id: "tool_1", kind: "tool", name: "read_file", status: "done" }],
          },
        },
      },
      {
        id: "task_1",
        topic_id: "topic_b",
        task: "First",
        status: "done",
        created_at: "2026-08-14T01:00:00Z",
        result: { final: { output: "Earlier" } },
      },
    ],
    t,
    {
      endpointRef: "ep_remote",
      agentName: "Momo",
      locale: "en-US",
      now: new Date("2026-08-14T03:00:00Z"),
    }
  );

  assert.deepEqual(
    items.map((item) => item.id),
    ["task_1:user", "task_1:agent", "task_2:user", "task_2:agent"]
  );
  assert.equal(items[2].endpointRef, "ep_remote");
  assert.equal(items[2].topicID, "topic_b");
  assert.equal(items[3].text, "Done");
  assert.equal(items[3].reasoning, "Checked both sources.");
  assert.deepEqual(items[3].plan, {
    steps: [{ step: "Check", status: "completed" }],
  });
  assert.equal(items[3].activity.current.name, "read_file");
});

test("task status helpers and taskAgentText keep runtime semantics", () => {
  assert.equal(normalizeTaskStatus("RUNNING"), "running");
  assert.equal(normalizeTaskStatus("unknown"), "queued");
  assert.equal(isTerminalStatus("done"), true);
  assert.equal(isTerminalStatus("pending"), false);
  assert.equal(
    taskAgentText(
      {
        id: "task_pending",
        status: "running",
      },
      t,
      { agentName: "Momo", pendingText: "Keep the streamed text." }
    ),
    "Keep the streamed text."
  );
  assert.equal(
    taskAgentText({ id: "task_program", status: "done", result: { output: " From the program. " } }, t),
    "From the program."
  );
  assert.equal(taskAgentText({ id: "task_empty", status: "done", result: {} }, t), "No output.");
});

test("finished plan steps with a note become the agent's messages", () => {
  const plan = normalizePlan({
    steps: [
      { step: "read", status: "completed", note: " 6 sections. " },
      { step: "write", status: "completed" },
      { step: "check", status: "in_progress", note: "not yet" },
    ],
  });
  assert.deepEqual(planStepMessages(plan), [{ key: "step:0", text: "6 sections." }]);
  assert.deepEqual(planStepMessages(null), []);
});

test("insights become the agent's messages, from the task result or a stream frame", async () => {
  const { insightMessages, normalizeInsights, taskInsights } = await import("./chat-task-history.js");
  const task = { id: "t", status: "done", result: { insights: [" The timeout is 0. ", "", "Retrying."] } };
  assert.deepEqual(taskInsights(task), ["The timeout is 0.", "Retrying."]);
  assert.deepEqual(insightMessages(taskInsights(task)), [
    { key: "insight:0", text: "The timeout is 0." },
    { key: "insight:1", text: "Retrying." },
  ]);
  assert.equal(taskInsights({ id: "t", result: {} }), null);
  assert.equal(normalizeInsights([" "]), null);
  assert.deepEqual(insightMessages(null), []);
  const [, agent] = taskListHistoryItems([{ ...task, task: "check", created_at: "2026-10-22T00:00:00Z" }], (key) => key);
  assert.deepEqual(agent.insights, ["The timeout is 0.", "Retrying."]);
});

test("a reply awaits until it has words, an error, an approval, or an end", async () => {
  const { taskAwaitingReply, pollingActionWord } = await import("./chat-task-history.js");
  assert.equal(taskAwaitingReply({ id: "t", status: "running" }), true);
  assert.equal(taskAwaitingReply({ id: "t", status: "queued" }), true);
  assert.equal(taskAwaitingReply({ id: "t", status: "running", result: { final: { output: "hi" } } }), false);
  assert.equal(taskAwaitingReply({ id: "t", status: "running", error: "boom" }), false);
  assert.equal(taskAwaitingReply({ id: "t", status: "done" }), false);
  assert.equal(taskAwaitingReply({ id: "t", status: "pending", approval_request_id: "a" }), false);
  assert.equal(pollingActionWord("seed"), pollingActionWord("seed"));
  assert.match(pollingActionWord("seed"), /^[a-z]+$/);
});

test("mergeRefreshedHistoryItems adds tasks from another device and keeps older pages", () => {
  const item = (taskId, role, text = "") => ({ id: `${taskId}:${role}`, taskId, role, text });
  const current = [
    item("t0", "user"),
    item("t0", "agent"),
    item("t1", "user"),
    item("t1", "agent", "partial"),
  ];
  const fresh = [
    item("t1", "user"),
    item("t2", "user", "steered from another device"),
    item("t1", "agent", "final"),
  ];
  const merged = mergeRefreshedHistoryItems(current, fresh);
  assert.equal(merged.overlap, true);
  assert.deepEqual(
    merged.items.map((entry) => entry.id),
    ["t0:user", "t0:agent", "t1:user", "t2:user", "t1:agent"]
  );
  assert.equal(merged.items[4].text, "final");
});

test("mergeRefreshedHistoryItems drops static and unconnected items", () => {
  const fresh = [{ id: "t5:user", taskId: "t5", role: "user" }];
  assert.deepEqual(
    mergeRefreshedHistoryItems([{ id: "chat-intro", role: "agent" }], fresh),
    { items: fresh, overlap: false }
  );
  assert.deepEqual(
    mergeRefreshedHistoryItems([{ id: "t1:user", taskId: "t1", role: "user" }], fresh),
    { items: fresh, overlap: false }
  );
});

test("agentLinkMessages lists the Agent Link exchange and drops a pending note once answered", () => {
  const activity = normalizeActivity({ history: [
    { id: "call_1", kind: "tool", name: "agent_send", status: "done", messages: [
      { direction: "sent", peer: "墨墨", text: "what is your name?" },
      { direction: "pending", peer: "墨墨" },
      { direction: "bogus", peer: "墨墨" },
    ] },
    { id: "call_2", kind: "tool", name: "agent_send", status: "done", messages: [
      { direction: "reply", peer: "墨墨", text: "I am 墨墨." },
    ] },
    { id: "call_3", kind: "tool", name: "agent_send", status: "running", messages: [
      { direction: "sent", peer: "Emma", text: "hi" },
      { direction: "pending", peer: "Emma" },
    ] },
  ] });
  const got = agentLinkMessages(activity).map((m) => `${m.direction}:${m.peer}`);
  assert.deepEqual(got, ["sent:墨墨", "reply:墨墨", "sent:Emma", "pending:Emma"]);
});

test("a reload keeps what the page shows for a running task until the task stores it", async () => {
  const { keepLiveTaskState } = await import("./chat-task-history.js");
  const current = [
    { id: "a", role: "agent", taskId: "run", status: "running", awaiting: false, text: "Streaming…", insights: ["Found a bug."] },
    { id: "b", role: "agent", taskId: "old", status: "done", text: "Old reply", insights: ["Old insight."] },
  ];
  const fresh = [
    { id: "run:agent", role: "agent", taskId: "run", status: "running", awaiting: true, text: "Thinking", insights: null },
    { id: "old:agent", role: "agent", taskId: "old", status: "done", text: "Old reply", insights: null },
    { id: "new:agent", role: "agent", taskId: "new", status: "running", awaiting: true, text: "Thinking", insights: null },
  ];
  const [running, finished, other] = keepLiveTaskState(current, fresh);
  assert.deepEqual(running.insights, ["Found a bug."]);
  assert.equal(running.text, "Streaming…");
  assert.equal(running.awaiting, false);
  assert.equal(running.id, "run:agent");
  assert.equal(finished.insights, null);
  assert.equal(other.text, "Thinking");

  // What the task list has wins.
  const [stored] = keepLiveTaskState(current, [{ ...fresh[0], insights: ["Stored."] }]);
  assert.deepEqual(stored.insights, ["Stored."]);
});

test("questions from the task result or a stream frame keep their choices and answer", () => {
  assert.equal(normalizeQuestions(undefined), null);
  assert.equal(normalizeQuestions([{ id: "", text: "x" }, { id: "q", text: " " }]), null);
  const questions = normalizeQuestions([
    {
      id: "q1",
      text: " Which account? ",
      options: [{ label: "Personal", description: "lyric@example.com" }, { label: " " }, { label: "Company" }],
      status: "answered",
      answer: "Company",
      option: 1,
    },
    { id: "q2", text: "Why?", status: "weird" },
  ]);
  assert.deepEqual(questions, [
    {
      id: "q1",
      text: "Which account?",
      options: [
        { label: "Personal", description: "lyric@example.com" },
        { label: "Company", description: "" },
      ],
      status: "answered",
      answer: "Company",
      option: 1,
    },
    { id: "q2", text: "Why?", options: [], status: "expired", answer: "", option: null },
  ]);

  const item = taskListHistoryItems(
    [{ id: "t1", status: "done", task: "send it", result: { final: { output: "sent" }, questions: [{ id: "q1", text: "Which?", status: "expired" }] } }],
    (key) => key
  ).find((entry) => entry.role === "agent");
  assert.equal(item.questions[0].status, "expired");

  const live = { id: "t2:agent", role: "agent", taskId: "t2", status: "running", questions: [{ id: "q3", text: "Now?", status: "open" }] };
  const [kept] = keepLiveTaskState([live], [{ ...live, questions: null }]);
  assert.equal(kept.questions[0].id, "q3");
});
