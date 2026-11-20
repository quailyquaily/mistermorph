// A coder's subtask in Progress keeps its task_id while it runs. A running task's activity comes
// over its stream; the polls in between bring none (the server stores it when the task ends), and
// the page keeps what it shows by normalizing it again. That once dropped the subtask's task_id
// (and output kind) until the next stream frame, so the field kept vanishing and coming back. Here
// the polls play both parts: some bring the activity, the rest bring none.
import { expect, test, type App } from "nsh/test";
import { openConsole, type ApiRequest } from "./harness";

const NOW = new Date().toISOString();
const CHAT = "/e/default/chat/topic-1";
const NO_WORKSPACE = { body: { workspace: { workspace_dir: "", source: "none" } } };

function coder(id: string, status: string) {
  return { id, kind: "tool", name: "coder", status, args: { backend: "codex", task: `fix ${id}` }, at: NOW };
}

function subtask(id: string, status: string, extra: Record<string, unknown> = {}) {
  return { id, kind: "subtask", name: id, status, task_id: id, mode: "direct", profile: "default", at: NOW, ...extra };
}

function task(id: string, status: string, activity: unknown) {
  return {
    id,
    task: `Run the coders ${id}`,
    topic_id: "topic-1",
    created_at: NOW,
    started_at: NOW,
    status,
    ...(status === "done" ? { finished_at: NOW, result: { final: { output: "Both fixed." }, activity } } : {}),
    // A running task's detail carries its activity only in the polls that stand in for a stream frame.
    ...(status === "running" && activity ? { result: { activity } } : {}),
  };
}

/** The task_id values the open Progress panel shows, in order: each one after its key. */
function shownTaskIDs(app: App) {
  const texts = app.texts().map((text) => text.trim());
  return texts.flatMap((text, index) => (text === "task_id" ? [texts[index + 1] ?? ""] : []));
}

async function openProgress(app: App) {
  await app.waitFor("id:chat-status-activity");
  await app.press("id:chat-status-activity");
  await app.waitFor("id:chat-detail-activity");
}

test("a coder subtask's task_id stays shown through running polls with no activity, and through completion", async () => {
  // What each poll of t1 answers, in order; the last one repeats.
  const steps = [
    // The coder call started, its subtask not yet: no task_id anywhere.
    task("t1", "running", { history: [coder("call-a", "running")] }),
    task("t1", "running", null),
    // Its subtask started, and a second coder beside it with its own.
    task("t1", "running", {
      history: [coder("call-a", "running"), subtask("sub_a", "running"), coder("call-b", "running"), subtask("sub_b", "running")],
    }),
    // Running updates that bring nothing about the subtasks.
    task("t1", "running", null),
    task("t1", "running", null),
    task("t1", "running", null),
    task("t1", "running", null),
    task("t1", "done", {
      history: [
        coder("call-a", "done"),
        subtask("sub_a", "done", { output_kind: "text" }),
        coder("call-b", "done"),
        subtask("sub_b", "done", { output_kind: "text" }),
      ],
    }),
  ];
  let polls = 0;
  const observed: string[][] = [];
  const { app } = await openConsole({
    location: CHAT,
    clock: true,
    api: {
      "GET /proxy:/topics": { body: { items: [{ id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW }] } },
      "GET /proxy:/topic/topic-1/metadata": NO_WORKSPACE,
      "GET /proxy:/tasks": (request: ApiRequest) =>
        request.uri?.includes("topic_id=topic-1") ? { body: { items: [steps[Math.min(polls, steps.length - 1)]] } } : { body: { items: [] } },
      "GET /proxy:/tasks/t1": () => {
        const step = steps[Math.min(polls, steps.length - 1)];
        polls += 1;
        return { body: step };
      },
    },
  });
  await openProgress(app);
  // Before the subtask started: the coder call shows, with no task_id.
  expect(app.shows("id:chat-detail-panel >> text:fix call-a")).toBe(true);
  expect(shownTaskIDs(app)).toEqual([]);

  await app.waitUntil(() => shownTaskIDs(app).length > 0, { timeout: 20000 });
  // Each later poll: both subtasks keep their own task_id, until the task is done.
  while (polls < steps.length) {
    const before = polls;
    await app.waitUntil(() => polls > before, { timeout: 20000 });
    observed.push(shownTaskIDs(app));
  }
  await app.waitFor("text:Both fixed.", { timeout: 20000 });
  observed.push(shownTaskIDs(app));
  for (const ids of observed) expect(ids).toEqual(["sub_a", "sub_b"]);
  expect(app.shows("id:chat-detail-panel >> text:fix call-b")).toBe(true);
});

test("the next task's coder shows no task_id of the one before", async () => {
  const first = task("t1", "done", {
    history: [coder("call-a", "done"), subtask("sub_a", "done", { output_kind: "text" })],
  });
  let polls = 0;
  const second = () => {
    polls += 1;
    // The new coder call has started; its subtask has not.
    return task("t2", "running", polls === 1 ? { history: [coder("call-c", "running")] } : null);
  };
  const { app } = await openConsole({
    location: CHAT,
    clock: true,
    api: {
      "GET /proxy:/topics": { body: { items: [{ id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW }] } },
      "GET /proxy:/topic/topic-1/metadata": NO_WORKSPACE,
      "GET /proxy:/tasks": (request: ApiRequest) =>
        request.uri?.includes("topic_id=topic-1") ? { body: { items: [first, task("t2", "running", null)] } } : { body: { items: [] } },
      "GET /proxy:/tasks/t2": () => ({ body: second() }),
    },
  });
  await app.waitUntil(() => polls >= 3, { timeout: 20000 });
  // The running reply's Progress: its own coder call only.
  await app.waitFor("id:chat-item-agent >> nth=1 >> id:chat-status-activity");
  await app.press("id:chat-item-agent >> nth=1 >> id:chat-status-activity");
  await app.waitFor("id:chat-detail-activity");
  expect(app.shows("id:chat-detail-panel >> text:fix call-c")).toBe(true);
  expect(app.shows("id:chat-detail-panel >> text:fix call-a")).toBe(false);
  expect(shownTaskIDs(app)).toEqual([]);
});
