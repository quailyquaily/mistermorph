// A reply's processes: the Processes column beside Progress opens the task's process tree in the
// detail panel (the workbench); it reads GET /tasks/{id}/processes, draws each call's processes as
// a tree with what was left behind marked, lists what was stopped, and Stop ends a process
// (POST /tasks/{id}/processes/kill). A reply that ran no shell or coder call has no column.
import { expect, test } from "nsh/test";
import { openConsole, type ApiRequest } from "./harness";

const NOW = new Date().toISOString();
const TOPICS = { body: { items: [{ id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW }] } };
const CHAT = "/e/default/chat/topic-1";
const NO_WORKSPACE = { body: { workspace: { workspace_dir: "", source: "none" } } };

function task(id: string, history: unknown[]) {
  return {
    id,
    task: "Start the loop",
    topic_id: "topic-1",
    created_at: NOW,
    started_at: NOW,
    finished_at: NOW,
    status: "done",
    result: { final: { output: "Started." }, activity: { history } },
  };
}

const TREE = {
  supported: true,
  known: true,
  running: false,
  groups: [
    {
      kind: "shell",
      program: "bash",
      activity_id: "a1",
      pid: 400,
      running: false,
      keep: true,
      processes: [
        {
          pid: 410,
          ppid: 1,
          name: "npm",
          command: "npm run dev",
          started_at: NOW,
          orphan: true,
          children: [{ pid: 411, ppid: 410, name: "node", command: "node server.js", started_at: NOW }],
        },
      ],
    },
  ],
  stopped: [{ pid: 420, name: "loop.sh", by: "sweep", at: NOW }],
};

function api(tasks: unknown[], kills: number[]) {
  return {
    "GET /proxy:/topics": TOPICS,
    "GET /proxy:/tasks": (request: ApiRequest) => (request.uri?.includes("topic_id=topic-1") ? { body: { items: tasks } } : { body: { items: [] } }),
    "GET /proxy:/topic/topic-1/metadata": NO_WORKSPACE,
    "GET /proxy:/tasks/t1/processes": { body: TREE },
    "POST /proxy:/tasks/t1/processes/kill": (request: ApiRequest) => {
      kills.push(Number(request.json?.pid));
      return { body: { stopped: [] } };
    },
  };
}

test("the Processes column opens the task's process tree, and Stop ends a process", async () => {
  const kills: number[] = [];
  const { app } = await openConsole({
    location: CHAT,
    api: api([task("t1", [{ id: "a1", kind: "tool", name: "bash", status: "done", args: { cmd: "npm run dev &" } }])], kills),
  });
  await app.waitFor("id:chat-status-processes");
  await app.press("id:chat-status-processes");
  await app.waitFor("id:chat-process-tree");
  await app.waitUntil(() => app.shows("id:chat-detail-panel >> text:410 npm"));
  expect(app.shows("id:chat-detail-panel >> text:Processes")).toBe(true);
  expect(app.shows("id:chat-detail-panel >> text:411 node")).toBe(true);
  expect(app.shows("id:chat-process-orphan")).toBe(true);
  expect(app.shows("id:chat-process-kept")).toBe(true);
  expect(app.shows("id:chat-process-stopped >> text:420 loop.sh")).toBe(true);
  expect(app.shows("id:chat-process-stopped >> text:when the task ended")).toBe(true);

  await app.press("id:chat-process-stop >> nth=0");
  await app.waitUntil(() => kills.length > 0);
  expect(kills[0]).toBe(410);
});

test("a reply without a shell or coder call has no Processes column", async () => {
  const { app } = await openConsole({
    location: CHAT,
    api: api([task("t1", [{ id: "a1", kind: "tool", name: "web_search", status: "done", args: { q: "x" } }])], []),
  });
  await app.waitFor("id:chat-status-activity");
  expect(app.shows("id:chat-status-processes")).toBe(false);
});
