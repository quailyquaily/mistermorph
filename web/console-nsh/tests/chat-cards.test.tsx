// What a reply carries besides its text: approvals, questions, password requests, the plan and
// progress card, copy, stop, and the raw JSON behind a reply.
import { expect, test } from "nsh/test";
import { openConsole, type ApiRequest } from "./harness";

const NOW = new Date().toISOString();
const TOPICS = { body: { items: [{ id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW }] } };
const CHAT = "/e/default/chat/topic-1";

function task(id: string, extra: Record<string, unknown>) {
  return { id, task: "Clean the disk", topic_id: "topic-1", created_at: NOW, started_at: NOW, ...extra };
}

function listOf(...items: unknown[]) {
  return (request: ApiRequest) => (request.uri?.includes("topic_id=topic-1") ? { body: { items } } : { body: { items: [] } });
}

test("an approval shows the tool and its parameters, and approving resumes the task", async () => {
  let approved = false;
  const pending = task("t1", {
    status: "pending",
    approval_request_id: "ap-1",
    result: { final: { output: { approval_request_id: "ap-1", message: "Needs your OK" } } },
  });
  const done = task("t1", { status: "done", finished_at: NOW, result: { final: { output: "Disk cleaned." } } });
  const { app, calls } = await openConsole({
    location: CHAT,
    api: {
      "GET /proxy:/topics": TOPICS,
      "GET /proxy:/tasks": (request: ApiRequest) => listOf(approved ? done : pending)(request),
      "GET /proxy:/tasks/t1": () => ({ body: approved ? done : pending }),
      "GET /proxy:/approvals": {
        body: { items: [{ approval_request_id: "ap-1", status: "pending", tool_name: "bash", reasons: [], tool_params: { cmd: "rm -rf /tmp/cache" } }] },
      },
      "POST /proxy:/approvals/ap-1/approve": () => {
        approved = true;
        return { body: { resumed: true } };
      },
    },
  });
  await app.waitFor("id:chat-approval");
  await app.waitFor("Approval required");
  await app.waitFor("bash");
  await app.waitFor("rm -rf /tmp/cache");
  await app.press("role:button[Approve]");
  await app.waitFor("text:Disk cleaned.", { timeout: 6000 });
  expect(calls.some((call) => call.uri === "/approvals/ap-1/approve" && call.json?.actor === "console:user")).toBe(true);
});

test("denying an approval cancels the task, and a failed decision says why", async () => {
  let fail = true;
  const pending = task("t1", {
    status: "pending",
    approval_request_id: "ap-1",
    result: { final: { output: { approval_request_id: "ap-1", message: "Needs your OK" } } },
  });
  const { app } = await openConsole({
    location: CHAT,
    api: {
      "GET /proxy:/topics": TOPICS,
      "GET /proxy:/tasks": listOf(pending),
      "GET /proxy:/tasks/t1": () => ({ body: fail ? pending : task("t1", { status: "canceled", error: "Approval denied. Task canceled." }) }),
      "GET /proxy:/approvals": { body: { items: [] } },
      "POST /proxy:/approvals/ap-1/deny": () => (fail ? { status: 500, body: { error: "approvals offline" } } : { body: {} }),
    },
  });
  await app.waitFor("role:button[Deny]");
  await app.press("role:button[Deny]");
  await app.waitFor("approvals offline");
  fail = false;
  await app.press("role:button[Deny]");
  await app.waitFor("Approval denied. Task canceled.");
  await app.waitFor("role:button[Deny]", { state: "gone" });
});

test("a question takes a choice, or typed text, and a closed one shows the answer", async () => {
  let answered: any = null;
  const running = task("t1", {
    status: "running",
    result: {
      questions: [{ id: "q1", text: "Which **city**?", options: [{ label: "Lisbon", description: "Coast" }, { label: "Porto" }], status: "open" }],
    },
  });
  const { app } = await openConsole({
    location: CHAT,
    api: {
      "GET /proxy:/topics": TOPICS,
      "GET /proxy:/tasks": listOf(running),
      "GET /proxy:/tasks/t1": () => ({
        body: answered
          ? task("t1", { status: "running", result: { questions: [{ id: "q1", text: "Which city?", status: "answered", answer: "Porto", option: 1 }] } })
          : running,
      }),
      "POST /proxy:/tasks/t1/answer": (request: ApiRequest) => {
        answered = request.json;
        return { body: { answered: true } };
      },
    },
  });
  await app.waitFor("id:chat-question");
  await app.waitFor("Lisbon");
  await app.waitFor("Coast");
  await app.press("label:Porto");
  await app.waitUntil(() => answered !== null);
  expect(answered).toEqual({ question_id: "q1", option: 1 });
  await app.waitFor("text:Porto", { timeout: 4000 });
  await app.waitFor("id:chat-question-input", { state: "gone", timeout: 4000 });
});

test("a typed answer that the task no longer takes says the question is closed", async () => {
  const running = task("t1", {
    status: "running",
    result: { questions: [{ id: "q1", text: "Anything else?", options: [], status: "open" }] },
  });
  const { app } = await openConsole({
    location: CHAT,
    api: {
      "GET /proxy:/topics": TOPICS,
      "GET /proxy:/tasks": listOf(running),
      "GET /proxy:/tasks/t1": { body: running },
      "POST /proxy:/tasks/t1/answer": { body: { answered: false } },
    },
  });
  await app.waitFor("id:chat-question-input");
  await app.type("id:chat-question-input", "No, thanks");
  await app.press("role:button[Send]");
  await app.waitFor("This question is closed.");
});

test("a password request sends the password once and clears the field", async () => {
  let body: any = null;
  const running = task("t1", {
    status: "running",
    result: {
      elevations: [{ id: "e1", command: "apt-get install jq", cwd: "/home/me", deadline: Math.floor(Date.now() / 1000) + 120, status: "open" }],
    },
  });
  const { app } = await openConsole({
    location: CHAT,
    api: {
      "GET /proxy:/topics": TOPICS,
      "GET /proxy:/tasks": listOf(running),
      "GET /proxy:/tasks/t1": { body: running },
      "POST /proxy:/tasks/t1/elevation": (request: ApiRequest) => {
        body = request.json;
        return { body: { accepted: true } };
      },
    },
  });
  await app.waitFor("id:chat-elevation");
  await app.waitFor("Administrator rights needed");
  await app.waitFor("apt-get install jq");
  await app.type("id:chat-elevation-password", "hunter2");
  await app.press("role:button[Allow]");
  await app.waitUntil(() => body !== null);
  expect(body).toMatchObject({ elevation_id: "e1", password: "hunter2", client: "web" });
  expect(app.value("id:chat-elevation-password")).toBe("");
});

test("the plan and progress fold open, the time shows the duration, and copy copies the reply", async () => {
  const done = task("t1", {
    status: "done",
    finished_at: new Date(Date.parse(NOW) + 125000).toISOString(),
    result: {
      final: { output: "All **done**." },
      plan: { steps: [{ step: "Look around", status: "completed" }, { step: "Clean up", status: "completed" }] },
      activity: { history: [{ id: "a1", kind: "tool", name: "bash", status: "done", args: { cmd: "du -sh" } }] },
    },
  });
  const { app } = await openConsole({
    location: CHAT,
    api: { "GET /proxy:/topics": TOPICS, "GET /proxy:/tasks": listOf(done) },
  });
  await app.waitFor("id:chat-status-card");
  await app.press("id:chat-status-plan");
  await app.waitFor("Look around");
  await app.press("id:chat-status-activity");
  await app.waitFor("du -sh");
  await app.waitFor("Look around", { state: "gone" });
  // The last reply shows how long it thought.
  await app.waitFor("2m5s");
  await app.press("id:chat-item-agent >> label:Copy");
  expect(app.clipboard()).toBe("All **done**.");
});

test("while a reply runs, Send becomes Stop and stops the task", async () => {
  let stopped = false;
  const running = task("t1", { status: "running" });
  const { app } = await openConsole({
    location: CHAT,
    api: {
      "GET /proxy:/topics": TOPICS,
      "GET /proxy:/tasks": listOf(running),
      "GET /proxy:/tasks/t1": () => ({ body: stopped ? task("t1", { status: "canceled", error: "Stopped." }) : running }),
      "POST /proxy:/tasks/t1/stop": () => {
        stopped = true;
        return { body: {} };
      },
    },
  });
  await app.waitFor("id:chat-awaiting");
  await app.waitFor("label:Stop Task");
  await app.press("id:chat-composer-send");
  await app.waitUntil(() => stopped);
  await app.waitFor("Stopped.", { timeout: 6000 });
  await app.waitFor("label:Send Task (Enter)");
});

test("five presses on a reply's time open its raw JSON", async () => {
  const done = task("t1", { status: "done", finished_at: NOW, result: { final: { output: "Ok." } } });
  const { app } = await openConsole({
    location: CHAT,
    api: { "GET /proxy:/topics": TOPICS, "GET /proxy:/tasks": listOf(done) },
  });
  await app.waitFor("text:Ok.");
  for (let i = 0; i < 5; i += 1) await app.press("id:chat-history-status");
  await app.waitFor("RAW JSON");
  await app.waitFor("id:raw-json-copy");
});

test("a history that fails to load shows the error", async () => {
  const { app } = await openConsole({
    location: CHAT,
    api: { "GET /proxy:/topics": TOPICS, "GET /proxy:/tasks": { status: 500, body: { error: "history store down" } } },
  });
  await app.waitFor("history store down");
});
