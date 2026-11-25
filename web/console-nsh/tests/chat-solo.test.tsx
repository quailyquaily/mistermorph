// Solo (FT186): the owner's one conversation, pinned first in the topic list; the cards of the work
// threads it starts, which follow the threads' state and open them; the summaries a thread sends
// when it ends; the chips under a reply naming what its run used; on phones too, and in Chinese
// and Japanese.
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import { openConsole, type ApiHandler, type ApiRequest } from "./harness";

const T0 = new Date(Date.now() - 60_000).toISOString();
const T1 = new Date(Date.now() - 50_000).toISOString();
const T2 = new Date(Date.now() - 10_000).toISOString();

function topic(id: string, title: string, extra: Record<string, unknown> = {}) {
  return { id, title, created_at: T0, updated_at: T0, ...extra };
}

const TOPICS = [
  topic("topic-1", "Trip plans", { tags: ["pinned"] }),
  topic("thread-1", "Build report", { started_from: "_solo" }),
  topic("_solo", "Solo"),
  topic("topic-2", "Recipes", { tags: ["food"] }),
];

/** Solo's history: a reply that started a thread (with its chips), the thread's card, and, once the
 * thread has ended, its summary. */
function soloTasks(state: string) {
  const items: any[] = [
    {
      id: "s1",
      task: "Build the report in ~/proj",
      topic_id: "_solo",
      status: "done",
      created_at: T0,
      started_at: T0,
      finished_at: T0,
      result: {
        final: { output: "I started a thread for the report." },
        solo_sources: [
          { kind: "thread", id: "thread-1", label: "Build report" },
          { kind: "workspace", id: "/home/u/proj", label: "~/proj" },
          { kind: "topic", id: "topic-2", label: "Recipes" },
          { kind: "memory" },
          { kind: "journal" },
        ],
      },
    },
    {
      id: "solothread_tt1",
      task: "",
      topic_id: "_solo",
      status: "done",
      created_at: T1,
      started_at: T1,
      finished_at: T1,
      result: {
        final: { output: 'Started work thread "Build report" (topic thread-1, workspace ~/proj).' },
        solo_thread: { kind: "card", topic_id: "thread-1", task_id: "tt1", title: "Build report", workspace: "~/proj", state },
      },
    },
  ];
  if (state === "done") {
    items.push({
      id: "solosummary_tt1",
      task: "",
      topic_id: "_solo",
      status: "done",
      created_at: T2,
      started_at: T2,
      finished_at: T2,
      result: {
        final: { output: 'Work thread "Build report" is done (topic thread-1, workspace ~/proj).\n\nReport ready: 42 pages' },
        solo_thread: { kind: "summary", topic_id: "thread-1", task_id: "tt1", title: "Build report", workspace: "~/proj", state: "done", summary: "Report ready: **42 pages**" },
      },
    });
  }
  return items;
}

function done(id: string, task: string, output: string, topicID: string) {
  return { id, task, topic_id: topicID, status: "done", created_at: T0, started_at: T0, finished_at: T0, result: { final: { output } } };
}

function runtime(state: () => string): Record<string, ApiHandler> {
  return {
    "GET /proxy:/topics": { body: { items: TOPICS } },
    "GET /proxy:/tasks": (request: ApiRequest) => {
      const uri = request.uri || "";
      if (uri.includes("topic_id=_solo")) return { body: { items: soloTasks(state()) } };
      if (uri.includes("topic_id=thread-1")) return { body: { items: [done("tt1", "thread work", "Working on the report in the thread.", "thread-1")] } };
      if (uri.includes("topic_id=topic-2")) return { body: { items: [done("t2", "Soup ideas", "Make a miso soup.", "topic-2")] } };
      return { body: { items: [done("t1", "Where to go?", "Try Lisbon.", "topic-1")] } };
    },
    "GET /proxy:/todo/tasks": { body: { tasks: [] } },
  };
}

/** The index of the first visible text that is `text`, or -1. */
function at(app: App, text: string) {
  return app.texts().indexOf(text);
}

test("Solo is pinned first in the date and tag views, and the threads it started are marked", async () => {
  const { app } = await openConsole({ location: "/e/default/chat", api: runtime(() => "running") });
  await app.waitFor("id:chat-topic-_solo");
  await app.waitFor("PINNED");
  await app.waitFor("id:chat-topic-solo-icon");
  // First of all the rows, before the pinned group and the day's topics.
  expect(at(app, "Solo")).toBeGreaterThanOrEqual(0);
  expect(at(app, "Solo")).toBeLessThan(at(app, "PINNED"));
  expect(at(app, "Solo")).toBeLessThan(at(app, "Recipes"));
  expect(app.count("id:chat-topic-row-_solo")).toBe(1);
  // A thread Solo started carries its mark; an ordinary topic does not.
  await app.waitFor("id:chat-topic-from-solo-thread-1");
  expect(app.shows("id:chat-topic-from-solo-topic-2")).toBe(false);
  await app.press("id:chat-topics-view-tags");
  await app.waitFor("food");
  expect(at(app, "Solo")).toBeLessThan(at(app, "food"));
  expect(app.count("id:chat-topic-row-_solo")).toBe(1);
});

test("a runtime without Solo lists no Solo", async () => {
  const api = runtime(() => "running");
  api["GET /proxy:/topics"] = { body: { items: TOPICS.filter((item) => item.id !== "_solo") } };
  const { app } = await openConsole({ location: "/e/default/chat", api });
  await app.waitFor("Recipes");
  expect(app.shows("id:chat-topic-_solo")).toBe(false);
});

test("a thread's card follows the thread live, its summary comes in when it ends, and both open it", async () => {
  let state = "running";
  const { app, calls } = await openConsole({ location: "/e/default/chat/_solo", clock: true, api: runtime(() => state) });
  await app.waitFor("text:I started a thread for the report.");
  await app.waitFor("id:chat-solo-thread.card.running");
  expect(app.shows("id:chat-solo-thread.card.running >> text:Build report")).toBe(true);
  expect(app.shows("id:chat-solo-thread.card.running >> text:~/proj")).toBe(true);
  expect(app.shows("id:chat-solo-thread.card.running >> text:Work thread started")).toBe(true);
  expect(app.shows("id:chat-solo-thread.card.running >> text:Running")).toBe(true);
  // The card's own line of text for the agent is not shown: the card stands in for it.
  expect(app.shows("text:/Started work thread/")).toBe(false);

  // The thread waits for the person: the card says so.
  state = "waiting";
  await app.clock!.runFor(3000);
  await app.waitFor("id:chat-solo-thread.card.waiting");
  expect(app.shows("id:chat-solo-thread.card.waiting >> text:Waiting for you")).toBe(true);

  // It ends: the card says done and the summary arrives, the thread's reply in it.
  state = "done";
  await app.clock!.runFor(3000);
  await app.waitFor("id:chat-solo-thread.card.done");
  await app.waitFor("id:chat-solo-thread.summary.done");
  expect(app.shows("id:chat-solo-thread.summary.done >> text:Work thread done")).toBe(true);
  await app.waitFor("text:/Report ready/");
  // With every thread ended, Solo stops asking again.
  const asked = calls.filter((call) => call.uri?.includes("topic_id=_solo")).length;
  await app.clock!.runFor(9000);
  expect(calls.filter((call) => call.uri?.includes("topic_id=_solo")).length).toBe(asked);

  // Open thread on the summary opens the thread's own conversation.
  await app.press("id:chat-solo-thread.summary.done >> id:chat-solo-thread-open");
  await app.waitFor("text:Working on the report in the thread.");
  expect(calls.some((call) => call.uri?.includes("topic_id=thread-1"))).toBe(true);
});

test("a reply's chips name what its run used, and its thread and topic chips open them", async () => {
  const { app, calls } = await openConsole({ location: "/e/default/chat/_solo", api: runtime(() => "done") });
  await app.waitFor("id:chat-solo-sources");
  for (const kind of ["thread", "workspace", "topic", "memory", "journal"]) {
    await app.waitFor(`id:chat-solo-source-${kind}`);
  }
  await app.waitFor("label:Thread: Build report");
  await app.waitFor("label:Workspace: ~/proj");
  await app.waitFor("label:Topic: Recipes");
  expect(app.shows("id:chat-solo-source-memory >> text:Memory")).toBe(true);
  expect(app.shows("id:chat-solo-source-journal >> text:Journal")).toBe(true);
  // Only the card and the summary are cards; the chips are under the reply alone.
  expect(app.count("id:chat-solo-sources")).toBe(1);
  await app.press("id:chat-solo-source-topic");
  await app.waitFor("text:Make a miso soup.");
  expect(calls.some((call) => call.uri?.includes("topic_id=topic-2"))).toBe(true);
  await app.press("id:chat-topic-_solo");
  await app.waitFor("id:chat-solo-source-thread");
  await app.press("id:chat-solo-source-thread");
  await app.waitFor("text:Working on the report in the thread.");
});

test("on a phone Solo heads the topic list, and its card opens the thread", async () => {
  const { app } = await openConsole({ location: "/e/default/chat", width: 390, height: 844, api: runtime(() => "running") });
  await app.waitFor("id:chat-topic-_solo");
  expect(at(app, "Solo")).toBeLessThan(at(app, "Recipes"));
  await app.press("id:chat-topic-_solo");
  await app.waitFor("id:chat-solo-thread.card.running");
  await app.waitFor("id:chat-solo-sources");
  await app.press("id:chat-solo-thread.card.running >> id:chat-solo-thread-open");
  await app.waitFor("text:Working on the report in the thread.");
});

const WORDS: Record<string, { started: string; running: string; ended: string; open: string; workspace: string; memory: string; from: string }> = {
  zh: { started: "已开始工作线程", running: "进行中", ended: "工作线程已完成", open: "打开线程", workspace: "工作区：~/proj", memory: "记忆", from: "从 Solo 开始" },
  ja: { started: "作業スレッドを開始", running: "実行中", ended: "作業スレッド完了", open: "スレッドを開く", workspace: "ワークスペース：~/proj", memory: "メモリー", from: "Solo から開始" },
};

for (const lang of ["zh", "ja"]) {
  test(`${lang}: the cards, their states and the chips are in the Console's language`, async () => {
    const words = WORDS[lang];
    let state = "running";
    const { app } = await openConsole({ location: "/e/default/chat/_solo", clock: true, kv: { "quail-language": lang }, api: runtime(() => state) });
    await app.waitFor("id:chat-solo-thread.card.running");
    expect(app.shows(`id:chat-solo-thread.card.running >> text:${words.started}`)).toBe(true);
    expect(app.shows(`id:chat-solo-thread.card.running >> text:${words.running}`)).toBe(true);
    expect(app.shows(`id:chat-solo-thread.card.running >> text:${words.open}`)).toBe(true);
    await app.waitFor(`label:${words.workspace}`);
    expect(app.shows(`id:chat-solo-source-memory >> text:${words.memory}`)).toBe(true);
    await app.waitFor(`label:${words.from}`);
    state = "done";
    await app.clock!.runFor(3000);
    await app.waitFor("id:chat-solo-thread.summary.done");
    expect(app.shows(`id:chat-solo-thread.summary.done >> text:${words.ended}`)).toBe(true);
  });
}
