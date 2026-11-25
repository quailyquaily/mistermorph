// Solo's chips and where Back goes (FT188). The workspace, memory and journal chips under a Solo
// reply open their details in a dialog, in place: what the reply's run did with the source, as the
// runtime recorded it (an action and a count), and for a reply from before that was kept an honest
// word that it was not. The thread and topic chips and a thread card's Open thread open the topic;
// on a phone Back from it (the bar's arrow, Android's Back) returns to Solo, and only then: a topic
// opened any other way, and every topic on the desktop layout, goes back as before.
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import { MOBILE_LOCATION_KEY, openConsole, type ApiHandler, type ApiRequest } from "./harness";
import { soloSourcesOf, soloSourceUsesOf } from "../lib/core/solo";

const T0 = new Date(Date.now() - 60_000).toISOString();
const T1 = new Date(Date.now() - 50_000).toISOString();
const T2 = new Date(Date.now() - 40_000).toISOString();

function topic(id: string, title: string, extra: Record<string, unknown> = {}) {
  return { id, title, created_at: T0, updated_at: T0, ...extra };
}

const TOPICS = [topic("topic-1", "Trip plans"), topic("thread-1", "Build report", { started_from: "_solo" }), topic("_solo", "Solo"), topic("topic-2", "Recipes")];

function reply(id: string, at: string, output: string, sources: unknown[]) {
  return { id, task: `ask ${id}`, topic_id: "_solo", status: "done", created_at: at, started_at: at, finished_at: at, result: { final: { output }, solo_sources: sources } };
}

/** Solo's history: a reply with what its run did, the thread's card, and a reply from before uses were kept. */
function soloTasks() {
  return [
    reply("s1", T0, "I started a thread for the report.", [
      { kind: "thread", id: "thread-1", label: "Build report", uses: [{ action: "start", count: 1 }] },
      {
        kind: "workspace",
        id: "/home/u/proj",
        label: "~/proj",
        uses: [
          { action: "select", count: 1 },
          { action: "read_file", count: 3 },
          { action: "shell", count: 2 },
          { action: "later_runtime_use", count: 4 },
        ],
      },
      { kind: "topic", id: "topic-2", label: "Recipes", uses: [{ action: "read", count: 1 }] },
      { kind: "memory", uses: [{ action: "search", count: 2 }, { action: "save", count: 1 }] },
      { kind: "journal", uses: [{ action: "read", count: 5 }] },
    ]),
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
        solo_thread: { kind: "card", topic_id: "thread-1", task_id: "tt1", title: "Build report", workspace: "~/proj", state: "running" },
      },
    },
  ];
}

/** A Solo history of one reply from before uses were kept: kind, id and label only. */
function oldSoloTasks() {
  return [reply("old", T2, "An older reply.", [{ kind: "workspace", id: "/srv/api", label: "/srv/api" }, { kind: "memory" }, { kind: "journal" }])];
}

function done(id: string, task: string, output: string, topicID: string) {
  return { id, task, topic_id: topicID, status: "done", created_at: T0, started_at: T0, finished_at: T0, result: { final: { output } } };
}

function runtime(solo: () => unknown[] = soloTasks): Record<string, ApiHandler> {
  return {
    "GET /proxy:/topics": { body: { items: TOPICS } },
    "GET /proxy:/tasks": (request: ApiRequest) => {
      const uri = request.uri || "";
      if (uri.includes("topic_id=_solo")) return { body: { items: solo() } };
      if (uri.includes("topic_id=thread-1")) return { body: { items: [done("tt1", "thread work", "Working on the report in the thread.", "thread-1")] } };
      if (uri.includes("topic_id=topic-2")) return { body: { items: [done("t2", "Soup ideas", "Make a miso soup.", "topic-2")] } };
      return { body: { items: [done("t1", "Where to go?", "Try Lisbon.", "topic-1")] } };
    },
    "GET /proxy:/todo/tasks": { body: { tasks: [] } },
  };
}

const DIALOG = "id:chat-solo-source-dialog";
/** Whether the open dialog shows `text` (a path is looked up among the texts: `text:/…` is a pattern). */
const inDialog = (app: App, text: string) => (text.includes("/") ? app.count(DIALOG) > 0 && app.texts().includes(text) : app.shows(`${DIALOG} >> text:${text}`));
/** The count the dialog shows beside a use. */
const useCount = (app: App, action: string, count: string) => app.shows(`id:chat-solo-source-use.${action} >> text:${count}`);

/** Where the phone app is: the location it saves for its next launch. */
const location = (app: App) => String(app.storage()[MOBILE_LOCATION_KEY] || "");
/** The last location the app wrote to the address bar (the web), and how: pushed, or in the entry's place. */
function lastWrite(app: App) {
  const writes = app.host.calls().filter((call) => call.name === "morph.history");
  return (writes.at(-1)?.data || {}) as { url?: string; op?: string };
}
const topicFetches = (calls: ApiRequest[], topicID: string) => calls.filter((call) => call.uri?.includes(`topic_id=${topicID}`)).length;

async function openDialog(app: App, kind: string) {
  await app.press(`id:chat-solo-source-${kind}`);
  await app.waitFor(DIALOG);
}

async function closeDialog(app: App, by: "done" | "close") {
  await app.press(`id:chat-solo-source-dialog-${by}`);
  await app.waitFor(DIALOG, { state: "gone" });
}

test("what a source's record holds is read safely: old records, repeats, bounds and malformed uses", () => {
  // A record from before uses were kept: the sources as they were, with no uses.
  expect(soloSourcesOf({ result: { solo_sources: [{ kind: "workspace", id: "/srv/api", label: "/srv/api" }, { kind: "memory" }] } })).toEqual([
    { kind: "workspace", id: "/srv/api", label: "/srv/api", uses: [] },
    { kind: "memory", id: "", label: "", uses: [] },
  ]);
  // A source listed again is one chip, where it first was, with the uses of both.
  expect(
    soloSourcesOf({
      result: {
        solo_sources: [
          { kind: "memory", uses: [{ action: "search", count: 2 }] },
          { kind: "journal", uses: [{ action: "read", count: 1 }] },
          { kind: "memory", uses: [{ action: "save", count: 1 }, { action: "search", count: 3 }] },
          { kind: "wormhole", id: "x", uses: [{ action: "read", count: 1 }] },
        ],
      },
    }),
  ).toEqual([
    { kind: "memory", id: "", label: "", uses: [{ action: "search", count: 5 }, { action: "save", count: 1 }] },
    { kind: "journal", id: "", label: "", uses: [{ action: "read", count: 1 }] },
  ]);
  // Uses are a name and a count and nothing else: whatever else a record carries is dropped, and
  // what is no action name or no count is no use.
  expect(
    soloSourceUsesOf([
      { action: "shell", count: 2, command: "cat secret", output: "secret" },
      { action: "cat /etc/passwd", count: 1 },
      { action: "Read", count: 1 },
      { action: "read_file", count: 0 },
      { action: "read_file", count: -3 },
      { action: "read_file", count: "many" },
      { action: "write_file", count: "2" },
      { action: "coder", count: 2.9 },
      { action: "search", count: 1e9 },
      null,
      "shell",
      { count: 3 },
    ]),
  ).toEqual([
    { action: "shell", count: 2 },
    { action: "write_file", count: 2 },
    { action: "coder", count: 2 },
    { action: "search", count: 9999 },
  ]);
  expect(soloSourceUsesOf(undefined)).toEqual([]);
  expect(soloSourceUsesOf({ action: "read", count: 1 })).toEqual([]);
  // No more kinds of use than a source can have, however many a record names.
  const many = Array.from({ length: 40 }, (_, index) => ({ action: `use_${index}`, count: 1 }));
  expect(soloSourceUsesOf(many).length).toBe(16);
  expect(soloSourcesOf({ result: {} })).toEqual([]);
});

test("the workspace, memory and journal chips open their details in a dialog, in place", async () => {
  const { app, calls } = await openConsole({ location: "/e/default/chat/_solo", api: runtime() });
  await app.waitFor("id:chat-solo-sources");
  // The three say what pressing them does; the thread and topic chips keep their names.
  await app.waitFor("label:Workspace: ~/proj, show details");
  await app.waitFor("label:Memory, show details");
  await app.waitFor("label:Journal, show details");
  await app.waitFor("label:Thread: Build report");
  await app.waitFor("label:Topic: Recipes");
  const before = { write: lastWrite(app).url, fetches: calls.length };

  // The workspace: its folder as the chip has it and in full, and what the run did there.
  await openDialog(app, "workspace");
  expect(inDialog(app, "Workspace")).toBe(true);
  expect(inDialog(app, "~/proj")).toBe(true);
  expect(inDialog(app, "/home/u/proj")).toBe(true);
  await app.waitFor("label:Folder: /home/u/proj");
  expect(app.shows("id:chat-solo-source-use.select >> text:Chose it as the workspace")).toBe(true);
  expect(app.shows("id:chat-solo-source-use.read_file >> text:Read files")).toBe(true);
  expect(useCount(app, "read_file", "3")).toBe(true);
  expect(app.shows("id:chat-solo-source-use.shell >> text:Ran shell commands")).toBe(true);
  expect(useCount(app, "shell", "2")).toBe(true);
  await app.waitFor("label:Read files: 3");
  // A use this Console has no words for is shown as one, not passed off as another.
  expect(app.shows("id:chat-solo-source-use.later_runtime_use >> text:Other use")).toBe(true);
  expect(useCount(app, "later_runtime_use", "4")).toBe(true);
  expect(inDialog(app, "Counted from this reply's successful tool calls.")).toBe(true);
  expect(app.count("id:chat-solo-source-dialog-empty")).toBe(0);
  await closeDialog(app, "done");

  // The memory and the journal, each with its own uses.
  await openDialog(app, "memory");
  expect(inDialog(app, "Memory")).toBe(true);
  expect(app.shows("id:chat-solo-source-use.search >> text:Searched the memory")).toBe(true);
  expect(useCount(app, "search", "2")).toBe(true);
  expect(app.shows("id:chat-solo-source-use.save >> text:Saved to the memory")).toBe(true);
  expect(app.count("id:chat-solo-source-use.read_file")).toBe(0);
  expect(app.count("id:chat-solo-source-dialog-path")).toBe(0);
  await closeDialog(app, "close");

  await openDialog(app, "journal");
  expect(inDialog(app, "Journal")).toBe(true);
  expect(app.shows("id:chat-solo-source-use.read >> text:Read journal entries")).toBe(true);
  expect(useCount(app, "read", "5")).toBe(true);
  expect(app.count("id:chat-solo-source-use.search")).toBe(0);
  await closeDialog(app, "done");

  // Nothing went anywhere: Solo is still open, the address is the same and nothing was fetched for it.
  await app.waitFor("text:I started a thread for the report.");
  expect(lastWrite(app).url).toBe(before.write);
  expect(topicFetches(calls, "topic-2") + topicFetches(calls, "thread-1")).toBe(0);

  // The thread and topic chips still open their topics.
  await app.press("id:chat-solo-source-topic");
  await app.waitFor("text:Make a miso soup.");
  expect(app.count(DIALOG)).toBe(0);
  await app.press("id:chat-topic-_solo");
  await app.waitFor("id:chat-solo-source-thread");
  await app.press("id:chat-solo-source-thread");
  await app.waitFor("text:Working on the report in the thread.");
});

test("a reply from before uses were kept names its source and says its details were not recorded", async () => {
  const { app } = await openConsole({ location: "/e/default/chat/_solo", api: runtime(oldSoloTasks) });
  await app.waitFor("id:chat-solo-sources");
  for (const [kind, name] of [
    ["workspace", "/srv/api"],
    ["memory", "Memory"],
    ["journal", "Journal"],
  ]) {
    await openDialog(app, kind);
    expect(inDialog(app, name)).toBe(true);
    await app.waitFor("id:chat-solo-source-dialog-empty");
    expect(inDialog(app, "This reply used it, but how was not recorded: the reply is from before these details were kept.")).toBe(true);
    expect(app.count("id:chat-solo-source-dialog-uses")).toBe(0);
    // A folder shown in full on the chip is not said twice.
    expect(app.count("id:chat-solo-source-dialog-path")).toBe(0);
    await closeDialog(app, "done");
  }
});

test("on a phone a details dialog opens over Solo and closes back to it", async () => {
  const { app } = await openConsole({ location: "/e/default/chat/_solo", width: 390, height: 844, platform: "android", api: runtime() });
  await app.waitFor("id:chat-solo-sources");
  await openDialog(app, "memory");
  expect(app.shows("id:chat-solo-source-use.search >> text:Searched the memory")).toBe(true);
  // Android's Back closes the dialog and leaves Solo open.
  await app.back();
  await app.waitFor(DIALOG, { state: "gone" });
  await app.waitFor("id:chat-solo-sources");
  expect(location(app)).toBe("/e/default/chat/_solo");
  await app.waitFor("label:Topics");
});

for (const lang of ["zh", "ja"]) {
  test(`${lang}: the details are in the Console's language`, async () => {
    const words = (
      {
        zh: { open: "工作区：~/proj，查看详情", title: "工作区", read: "读取文件", back: "返回 Solo" },
        ja: { open: "ワークスペース：~/proj、詳細を表示", title: "ワークスペース", read: "ファイルを読み取り", back: "Solo に戻る" },
      } as Record<string, { open: string; title: string; read: string; back: string }>
    )[lang];
    const { app } = await openConsole({ location: "/e/default/chat/_solo", width: 390, height: 844, kv: { "quail-language": lang }, api: runtime() });
    await app.waitFor(`label:${words.open}`);
    await openDialog(app, "workspace");
    expect(inDialog(app, words.title)).toBe(true);
    expect(app.shows(`id:chat-solo-source-use.read_file >> text:${words.read}`)).toBe(true);
    await closeDialog(app, "done");
    await app.press("id:chat-solo-source-thread");
    await app.waitFor("text:Working on the report in the thread.");
    await app.waitFor(`label:${words.back}`);
  });
}

/** Solo open on a phone (the Android app unless `web`), its chips and the thread's card shown. */
async function openPhoneSolo(options: { web?: boolean } = {}) {
  const opened = await openConsole({
    location: "/e/default/chat/_solo",
    width: 390,
    height: 844,
    ...(options.web ? {} : { platform: "android" as const }),
    api: runtime(),
  });
  await opened.app.waitFor("id:chat-solo-sources");
  await opened.app.waitFor("label:Topics");
  return opened;
}

/** Solo is the open conversation again, with the arrow that leads to the topic list. */
async function expectSolo(app: App) {
  await app.waitFor("text:I started a thread for the report.");
  await app.waitFor("id:chat-solo-sources");
  await app.waitFor("label:Topics");
  await app.waitFor("label:Back to Solo", { state: "gone" });
  await app.waitUntil(() => location(app) === "/e/default/chat/_solo");
}

const FROM_SOLO: { name: string; press: string; shows: string; at: string }[] = [
  { name: "a thread chip", press: "id:chat-solo-source-thread", shows: "text:Working on the report in the thread.", at: "/e/default/chat/thread-1" },
  { name: "a topic chip", press: "id:chat-solo-source-topic", shows: "text:Make a miso soup.", at: "/e/default/chat/topic-2" },
  { name: "a thread card's Open thread", press: "id:chat-solo-thread.card.running >> id:chat-solo-thread-open", shows: "text:Working on the report in the thread.", at: "/e/default/chat/thread-1" },
];

for (const way of FROM_SOLO) {
  test(`on a phone, Back from a topic opened by ${way.name} returns to Solo`, async () => {
    const { app } = await openPhoneSolo();
    // The bar's arrow.
    await app.press(way.press);
    await app.waitFor(way.shows);
    await app.waitUntil(() => location(app) === way.at);
    await app.waitFor("label:Back to Solo");
    expect(app.count("label:Topics")).toBe(0);
    await app.press("id:chat-back");
    await expectSolo(app);

    // Android's Back, the same.
    await app.press(way.press);
    await app.waitFor(way.shows);
    await app.waitFor("label:Back to Solo");
    await app.back();
    await expectSolo(app);

    // From Solo, Back goes to the topic list as it always did.
    await app.back();
    await app.waitFor("id:chat-topic-sidebar");
    await app.waitFor("id:chat-back", { state: "gone" });
    await app.waitUntil(() => location(app) === "/e/default/chat");
  });
}

test("in a phone browser the topic takes its own place in the history, and the arrow puts Solo there", async () => {
  const { app } = await openPhoneSolo({ web: true });
  await app.press("id:chat-solo-source-thread");
  await app.waitFor("text:Working on the report in the thread.");
  await app.waitFor("label:Back to Solo");
  // Pushed after Solo: the browser's own back already leads there.
  await app.waitUntil(() => lastWrite(app).url === "/e/default/chat/thread-1");
  expect(lastWrite(app).op).toBe("push");
  await app.press("id:chat-back");
  await app.waitFor("id:chat-solo-sources");
  await app.waitFor("label:Topics");
  await app.waitUntil(() => lastWrite(app).url === "/e/default/chat/_solo");
  expect(lastWrite(app).op).toBe("replace");
});

test("on a phone, a topic opened from the list goes back to the list, also after it was once opened from Solo", async () => {
  const { app } = await openPhoneSolo();
  // Opened from Solo, and back there.
  await app.press("id:chat-solo-source-thread");
  await app.waitFor("label:Back to Solo");
  await app.press("id:chat-back");
  await expectSolo(app);
  // To the list, and the same thread from there: it no longer leads to Solo.
  await app.press("id:chat-back");
  await app.waitFor("id:chat-topic-sidebar");
  await app.waitFor("id:chat-back", { state: "gone" });
  await app.press("id:chat-topic-thread-1");
  await app.waitFor("text:Working on the report in the thread.");
  await app.waitFor("label:Topics");
  expect(app.count("label:Back to Solo")).toBe(0);
  await app.back();
  await app.waitFor("id:chat-topic-sidebar");
  await app.waitFor("id:chat-back", { state: "gone" });
  await app.waitUntil(() => location(app) === "/e/default/chat");

  // An ordinary topic, and Solo itself, from the list: the list is where Back goes.
  await app.press("id:chat-topic-topic-1");
  await app.waitFor("text:Try Lisbon.");
  await app.waitFor("label:Topics");
  await app.press("id:chat-back");
  await app.waitFor("id:chat-topic-sidebar");
  await app.waitFor("id:chat-back", { state: "gone" });

  // Opened from Solo once more, it leads back to Solo once more.
  await app.press("id:chat-topic-_solo");
  await app.waitFor("id:chat-solo-sources");
  await app.press("id:chat-solo-source-topic");
  await app.waitFor("text:Make a miso soup.");
  await app.waitFor("label:Back to Solo");
  await app.press("id:chat-back");
  await expectSolo(app);
});

test("on a phone, a new topic started after a visit from Solo goes back to the list", async () => {
  const { app } = await openPhoneSolo();
  await app.press("id:chat-solo-source-thread");
  await app.waitFor("label:Back to Solo");
  await app.press("id:chat-back");
  await expectSolo(app);
  await app.press("id:chat-back");
  await app.waitFor("id:chat-topic-sidebar");
  await app.waitFor("id:chat-back", { state: "gone" });
  await app.press("id:chat-topic-new-fab");
  await app.waitFor("id:chat-back");
  expect(app.count("label:Back to Solo")).toBe(0);
  await app.back();
  await app.waitFor("id:chat-topic-sidebar");
  await app.waitFor("id:chat-back", { state: "gone" });
  await app.waitUntil(() => location(app) === "/e/default/chat");
});

test("on the desktop layout a topic opened from Solo keeps no way back, also when the window narrows", async () => {
  const { app } = await openConsole({ location: "/e/default/chat/_solo", api: runtime() });
  await app.waitFor("id:chat-solo-sources");
  expect(app.count("id:chat-back")).toBe(0);
  await app.press("id:chat-solo-source-thread");
  await app.waitFor("text:Working on the report in the thread.");
  // As before: the thread is open beside the topic list, with no back arrow.
  expect(app.count("id:chat-back")).toBe(0);
  expect(app.count("id:chat-topic-_solo")).toBe(1);
  await app.waitUntil(() => lastWrite(app).url === "/e/default/chat/thread-1");
  // Narrowed to a phone's width afterwards, its arrow goes to the topic list.
  await app.setViewport(390, 844);
  await app.waitFor("id:chat-back");
  await app.waitFor("label:Topics");
  expect(app.count("label:Back to Solo")).toBe(0);
  await app.press("id:chat-back");
  await app.waitFor("id:chat-topic-sidebar");
  await app.waitFor("id:chat-back", { state: "gone" });
  await app.waitUntil(() => lastWrite(app).url === "/e/default/chat");
});
