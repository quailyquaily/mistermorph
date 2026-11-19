// A reply's processes: the Processes column beside Progress opens the task's process tree in the
// detail panel (the workbench); it reads GET /tasks/{id}/processes, draws each call's processes as
// a tree with what was left behind marked, lists what was stopped, and Stop ends a process
// (POST /tasks/{id}/processes/kill).
//
// The column shows only while the task has a process running, as that reading says
// (components/chat/taskProcesses.ts), whatever the reply called and whether the task still runs:
// it comes when the first process starts, stays while any runs (a kept server, an orphan left
// behind by a finished task), and goes with the last, closing the panel if it is open. What was
// only stopped, a failed read, an agent that cannot track processes or does not know the task show
// none. Each task (and endpoint) has its own reading, and a late answer never overwrites a newer.
import { expect, test } from "nsh/test";
import { effect, signal, untracked } from "nsh";
import { openConsole, type ApiRequest, LOCAL_REF } from "./harness";
import { createTaskProcessStore, processTreeLive, type ProcessTree } from "../components/chat/taskProcesses";

const NOW = new Date().toISOString();
const TOPICS = { body: { items: [{ id: "topic-1", title: "Ops", created_at: NOW, updated_at: NOW }] } };
const CHAT = "/e/default/chat/topic-1";
const NO_WORKSPACE = { body: { workspace: { workspace_dir: "", source: "none" } } };
/** Long enough for a finished reply's slower reading (5 s) to come round again (on the manual clock). */
const POLL = { timeout: 12_000 };

const BASH = [{ id: "a1", kind: "tool", name: "bash", status: "done", args: { cmd: "npm run dev &" } }];

function task(id: string, history: unknown[], text = "Start the loop", status = "done") {
  return {
    id,
    task: text,
    topic_id: "topic-1",
    created_at: NOW,
    started_at: NOW,
    finished_at: NOW,
    status,
    result: { final: { output: `Done: ${text}.` }, activity: { history } },
  };
}

/** A finished task's tree: a kept dev server whose shell has exited, and a sweep's stop. */
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

/** Only history: the task still runs, but every process it started has exited or was stopped. */
const EXITED = {
  supported: true,
  known: true,
  running: true,
  groups: [],
  stopped: [{ pid: 420, name: "loop.sh", by: "user", at: NOW }],
};

function shellGroup(pid: number, name: string, running = true) {
  return {
    kind: "shell",
    program: "bash",
    activity_id: `a${pid}`,
    pid,
    running,
    processes: [{ pid, ppid: 1, name, command: name, started_at: NOW }],
  };
}

function treeOf(groups: unknown[], extra: Record<string, unknown> = {}) {
  return { supported: true, known: true, running: false, groups, ...extra };
}

/** Process reads by task, as the agent was asked them. */
function processReads(calls: ApiRequest[], taskID: string) {
  return calls.filter((call) => call.method === "GET" && call.uri === `/tasks/${taskID}/processes`);
}

function api(tasks: unknown[], routes: Record<string, unknown> = {}) {
  return {
    "GET /proxy:/topics": TOPICS,
    "GET /proxy:/tasks": (request: ApiRequest) => (request.uri?.includes("topic_id=topic-1") ? { body: { items: tasks } } : { body: { items: [] } }),
    "GET /proxy:/topic/topic-1/metadata": NO_WORKSPACE,
    ...routes,
  } as Record<string, any>;
}

test("the Processes column opens the task's process tree, and Stop ends a process", async () => {
  const kills: number[] = [];
  const { app } = await openConsole({
    location: CHAT,
    api: api([task("t1", BASH)], {
      "GET /proxy:/tasks/t1/processes": { body: TREE },
      "POST /proxy:/tasks/t1/processes/kill": (request: ApiRequest) => {
        kills.push(Number(request.json?.pid));
        return { body: { stopped: [] } };
      },
    }),
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
  // The server still answers with a running process: the panel and its column stay.
  expect(app.shows("id:chat-process-tree")).toBe(true);
  expect(app.shows("id:chat-status-processes")).toBe(true);
});

test("a task whose processes have all exited has no Processes column, even while it runs", async () => {
  const { app, calls } = await openConsole({
    clock: true,
    location: CHAT,
    api: api([task("t1", BASH, "Start the loop", "running")], { "GET /proxy:/tasks/t1/processes": { body: EXITED } }),
  });
  await app.waitFor("id:chat-status-activity");
  await app.waitUntil(() => processReads(calls, "t1").length >= 2, POLL);
  expect(app.shows("id:chat-status-processes")).toBe(false);
});

test("a task with a live process shows the column whatever its reply called", async () => {
  const { app } = await openConsole({
    location: CHAT,
    api: api([task("t1", [{ id: "a1", kind: "tool", name: "web_search", status: "done", args: { q: "x" } }])], {
      "GET /proxy:/tasks/t1/processes": { body: treeOf([shellGroup(500, "watcher", false)]) },
    }),
  });
  await app.waitFor("id:chat-status-processes");
  expect(app.shows("id:chat-status-activity")).toBe(true);
});

test("the column comes with the first process, stays while one of several runs, and goes with the last", async () => {
  let tree: unknown = treeOf([]);
  const { app, calls } = await openConsole({
    clock: true,
    location: CHAT,
    api: api([task("t1", BASH)], { "GET /proxy:/tasks/t1/processes": () => ({ body: tree }) }),
  });
  await app.waitFor("id:chat-status-activity");
  await app.waitUntil(() => processReads(calls, "t1").length >= 1);
  expect(app.shows("id:chat-status-processes")).toBe(false);

  // Two start: the column comes without a reload.
  tree = treeOf([shellGroup(600, "server"), shellGroup(700, "watcher")]);
  await app.waitFor("id:chat-status-processes", POLL);

  // One of them exits: the other still runs, so the column stays (two reads after the change, so
  // at least one answered with it).
  tree = treeOf([shellGroup(700, "watcher")]);
  let mark = processReads(calls, "t1").length;
  await app.waitUntil(() => processReads(calls, "t1").length >= mark + 2, POLL);
  expect(app.shows("id:chat-status-processes")).toBe(true);

  // The last one exits: only history is left, and the column goes.
  tree = treeOf([], { stopped: [{ pid: 700, name: "watcher", by: "sweep", at: NOW }] });
  await app.waitFor("id:chat-status-processes", { state: "gone", ...POLL });
  mark = processReads(calls, "t1").length;
  await app.waitUntil(() => processReads(calls, "t1").length >= mark + 1, POLL);
  expect(app.shows("id:chat-status-processes")).toBe(false);
  expect(app.shows("id:chat-status-activity")).toBe(true);
});

test("an open Processes panel closes when the last process exits on its own", async () => {
  let tree: unknown = TREE;
  const { app } = await openConsole({
    clock: true,
    location: CHAT,
    api: api([task("t1", BASH)], { "GET /proxy:/tasks/t1/processes": () => ({ body: tree }) }),
  });
  await app.press("id:chat-status-processes");
  await app.waitUntil(() => app.shows("id:chat-detail-panel >> text:410 npm"));

  tree = { ...EXITED, running: false };
  await app.waitFor("id:chat-detail-panel", { state: "gone", ...POLL });
  expect(app.shows("id:chat-status-processes")).toBe(false);
  // The rest of the reply's entries are as they were, and open as before.
  await app.press("id:chat-status-activity");
  await app.waitFor("id:chat-detail-activity");
});

test("Stop on the last process closes the panel and the column", async () => {
  let tree: unknown = treeOf([shellGroup(800, "loop.sh", false)]);
  const kills: number[] = [];
  const { app } = await openConsole({
    location: CHAT,
    api: api([task("t1", BASH)], {
      "GET /proxy:/tasks/t1/processes": () => ({ body: tree }),
      "POST /proxy:/tasks/t1/processes/kill": (request: ApiRequest) => {
        kills.push(Number(request.json?.pid));
        tree = treeOf([], { stopped: [{ pid: 800, name: "loop.sh", by: "user", at: NOW }] });
        return { body: { stopped: [{ pid: 800, name: "loop.sh", by: "user", at: NOW }] } };
      },
    }),
  });
  await app.press("id:chat-status-processes");
  await app.waitUntil(() => app.shows("id:chat-detail-panel >> text:800 loop.sh"));
  await app.press("id:chat-process-stop");
  await app.waitFor("id:chat-detail-panel", { state: "gone" });
  expect(kills).toEqual([800]);
  expect(app.shows("id:chat-status-processes")).toBe(false);
  expect(app.shows("id:chat-status-activity")).toBe(true);
});

test("each task reads its own processes, and switching tasks shows that task's", async () => {
  const { app, calls } = await openConsole({
    location: CHAT,
    api: api([task("t1", BASH, "First"), task("t2", BASH, "Second"), task("t3", BASH, "Third")], {
      "GET /proxy:/tasks/t1/processes": { body: treeOf([shellGroup(901, "one-server")]) },
      "GET /proxy:/tasks/t2/processes": { body: treeOf([], { other: [{ pid: 902, ppid: 1, name: "two-orphan", started_at: NOW, orphan: true }] }) },
      "GET /proxy:/tasks/t3/processes": { body: EXITED },
    }),
  });
  await app.waitUntil(() => app.count("id:chat-status-processes") === 2, POLL);
  await app.waitUntil(() => processReads(calls, "t3").length >= 1);
  // Every read asks the reply's own endpoint.
  expect(calls.filter((call) => call.uri?.endsWith("/processes")).every((call) => call.endpoint === LOCAL_REF)).toBe(true);

  await app.press("id:chat-status-processes >> nth=0");
  await app.waitUntil(() => app.shows("id:chat-detail-panel >> text:901 one-server"));
  expect(app.shows("id:chat-detail-panel >> text:902 two-orphan")).toBe(false);

  await app.press("id:chat-status-processes >> nth=1");
  await app.waitUntil(() => app.shows("id:chat-detail-panel >> text:902 two-orphan"));
  expect(app.shows("id:chat-detail-panel >> text:901 one-server")).toBe(false);
  expect(app.shows("id:chat-process-orphan")).toBe(true);
  // The other tasks' columns are as their own readings say.
  expect(app.count("id:chat-status-processes")).toBe(2);
});

test("a failed, unsupported or unknown reading shows no column", async () => {
  const { app, calls } = await openConsole({
    clock: true,
    location: CHAT,
    api: api([task("t1", BASH, "First"), task("t2", BASH, "Second"), task("t3", BASH, "Third")], {
      "GET /proxy:/tasks/t1/processes": { status: 503, body: { error: "process listing failed" } },
      "GET /proxy:/tasks/t2/processes": { body: { supported: false, known: false, running: false, groups: [] } },
      // An agent that restarted does not know the task, though it named processes before.
      "GET /proxy:/tasks/t3/processes": { body: { ...TREE, known: false } },
    }),
  });
  await app.waitFor("id:chat-status-activity >> nth=2");
  // A failed read is read again (it may answer next time); an agent that cannot track processes
  // is not asked again.
  await app.waitUntil(() => processReads(calls, "t1").length >= 3, { timeout: 20_000 });
  expect(processReads(calls, "t2").length).toBe(1);
  expect(processReads(calls, "t3").length).toBeGreaterThan(0);
  expect(app.shows("id:chat-status-processes")).toBe(false);
});

test("a live reading that then fails hides the column", async () => {
  let fail = false;
  const { app } = await openConsole({
    clock: true,
    location: CHAT,
    api: api([task("t1", BASH)], {
      "GET /proxy:/tasks/t1/processes": () => (fail ? { status: 503, body: { error: "down" } } : { body: TREE }),
    }),
  });
  await app.waitFor("id:chat-status-processes");
  fail = true;
  await app.waitFor("id:chat-status-processes", { state: "gone", ...POLL });
});

// The reading itself, on a fetch whose answers the test gives in any order.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

function fakeFetch() {
  const asked: { endpointRef: string; path: string; answer: ReturnType<typeof deferred<unknown>> }[] = [];
  const fetch = (endpointRef: string, path: string) => {
    const answer = deferred<unknown>();
    asked.push({ endpointRef, path, answer });
    return answer.promise;
  };
  return { asked, fetch };
}

test("what is live: a running root or any process left, never history or the task's own state", () => {
  expect(processTreeLive(null)).toBe(false);
  expect(processTreeLive(EXITED as ProcessTree)).toBe(false);
  expect(processTreeLive({ ...EXITED, running: true } as ProcessTree)).toBe(false);
  expect(processTreeLive(TREE as ProcessTree)).toBe(true);
  expect(processTreeLive({ ...TREE, known: false } as ProcessTree)).toBe(false);
  expect(processTreeLive({ ...TREE, supported: false } as ProcessTree)).toBe(false);
  expect(processTreeLive(treeOf([{ ...shellGroup(1, "x"), processes: [] }]) as ProcessTree)).toBe(true);
  expect(processTreeLive(treeOf([{ ...shellGroup(1, "x", false), processes: [] }]) as ProcessTree)).toBe(false);
  expect(processTreeLive(treeOf([], { other: [{ pid: 2, ppid: 1, name: "y", started_at: NOW }] }) as ProcessTree)).toBe(true);
});

test("a late answer never overwrites a newer one, nor another task's reading", async () => {
  const { asked, fetch } = fakeFetch();
  const store = createTaskProcessStore(fetch);
  const endpoint = signal("ep-a");
  const taskID = signal("t1");
  let reading!: ReturnType<typeof store.watch>;
  effect(() => untracked(() => (reading = store.watch(endpoint, taskID))));
  await settle();
  expect(asked.map((entry) => `${entry.endpointRef} ${entry.path}`)).toEqual(["ep-a /tasks/t1/processes"]);

  // A Stop's read goes out while the poll is still on its way, and answers first: nothing left.
  const refresh = store.refresh("ep-a", "t1");
  expect(asked.length).toBe(2);
  asked[1].answer.resolve(treeOf([]));
  await refresh;
  expect(untracked(reading).loaded).toBe(true);
  expect(untracked(reading).live).toBe(false);
  // The poll's older answer, with the process still there, comes late and is dropped.
  asked[0].answer.resolve(TREE);
  await settle();
  expect(untracked(reading).live).toBe(false);

  // Another task: its own reading, empty until it answers; the first task's late answer is not it.
  const before = asked.length;
  taskID.set("t2");
  await settle();
  expect(untracked(reading).loaded).toBe(false);
  expect(asked.slice(before).map((entry) => entry.path)).toEqual(["/tasks/t2/processes"]);
  store.refresh("ep-a", "t1");
  expect(asked.length).toBe(before + 1); // t1 is no longer watched: nothing to refresh
  expect(store.size()).toBe(1);

  // Another endpoint with the same task id is another reading too.
  endpoint.set("ep-b");
  await settle();
  const last = asked.at(-1)!;
  expect(`${last.endpointRef} ${last.path}`).toBe("ep-b /tasks/t2/processes");
  asked[before].answer.resolve(TREE); // ep-a's t2, answered after the switch
  await settle();
  expect(untracked(reading).loaded).toBe(false);
  last.answer.resolve(TREE);
  await settle();
  expect(untracked(reading).live).toBe(true);

  // No task: nothing watched, nothing read again.
  taskID.set("");
  await settle();
  expect(store.size()).toBe(0);
  expect(untracked(reading).live).toBe(false);
});

test("watchers of one task share a reading, which ends with the last of them", async () => {
  const { asked, fetch } = fakeFetch();
  const store = createTaskProcessStore(fetch);
  const rowTask = signal("t1");
  const panelTask = signal("t1");
  const fast = signal(false);
  let row!: ReturnType<typeof store.watch>;
  let panel!: ReturnType<typeof store.watch>;
  effect(() =>
    untracked(() => {
      row = store.watch(() => "ep", rowTask, { fast });
      panel = store.watch(() => "ep", panelTask, { fast: () => true });
    }),
  );
  await settle();
  // One read for both, and one answer seen by both.
  expect(asked.length).toBe(1);
  expect(store.size()).toBe(1);
  asked[0].answer.resolve(TREE);
  await settle();
  expect(untracked(row).live).toBe(true);
  expect(untracked(panel).live).toBe(true);

  // A row whose watch only changes (its task finished: no longer fast) keeps the reading.
  fast.set(true);
  await settle();
  expect(store.size()).toBe(1);
  expect(untracked(row).live).toBe(true);

  panelTask.set("");
  await settle();
  expect(store.size()).toBe(1);
  rowTask.set("");
  await settle();
  expect(store.size()).toBe(0);
});
