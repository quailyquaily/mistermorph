// Who worked on a Solo task (FT189). A work thread's card and its summary show the subagents and
// coders the thread's task started: avatar, name and state for the newest three, then how many
// more, live while the task runs and the same after it ended. The chip of the thread under the
// reply that started it shows their avatars, with their names, kinds and states in its name, but
// only for exactly that task and only while that task's card is loaded: a chip that names no task
// (the reply only read the thread, or started it twice), one whose card is not there, and every
// other kind of chip stay as they were.
import { expect, test } from "nsh/test";
import { openConsole, type ApiHandler, type ApiRequest } from "./harness";
import { soloParticipantRoster, soloParticipantsOf, soloSourcesOf, soloThreadOf, soloThreadOfSource } from "../lib/core/solo";
import { WORKER_NAME_POOLS, workerAvatarStyle } from "../lib/core/worker-identity";

const T0 = new Date(Date.now() - 60_000).toISOString();
const T1 = new Date(Date.now() - 50_000).toISOString();
const T2 = new Date(Date.now() - 40_000).toISOString();
const T3 = new Date(Date.now() - 30_000).toISOString();

const TOPICS = [
  { id: "topic-1", title: "Trip plans", created_at: T0, updated_at: T0 },
  { id: "thread-1", title: "Build report", created_at: T0, updated_at: T0, started_from: "_solo" },
  { id: "_solo", title: "Solo", created_at: T0, updated_at: T0 },
];

/** A worker as the runtime names one: the scientist at `index`, in the logo style at `avatar`. */
function worker(n: number, kind: string, status: string, index = n, avatar = n) {
  return { id: `worker-${n}`, name: WORKER_NAME_POOLS.en[index], name_set: "scientists", name_index: index, avatar_index: avatar, kind, status };
}
const nameOf = (lang: "en" | "zh" | "ja", index: number) => WORKER_NAME_POOLS[lang][index];

function reply(id: string, at: string, output: string, sources: unknown[]) {
  return { id, task: `ask ${id}`, topic_id: "_solo", status: "done", created_at: at, started_at: at, finished_at: at, result: { final: { output }, solo_sources: sources } };
}

function record(kind: "card" | "summary", taskID: string, at: string, thread: Record<string, unknown>) {
  return {
    id: `${kind === "card" ? "solothread" : "solosummary"}_${taskID}`,
    task: "",
    topic_id: "_solo",
    status: "done",
    created_at: at,
    started_at: at,
    finished_at: at,
    result: {
      final: { output: `Work thread record ${taskID}.` },
      solo_thread: { kind, topic_id: "thread-1", task_id: taskID, title: "Build report", workspace: "~/proj", state: "running", ...thread },
    },
  };
}

function done(id: string, task: string, output: string, topicID: string) {
  return { id, task, topic_id: topicID, status: "done", created_at: T0, started_at: T0, finished_at: T0, result: { final: { output } } };
}

function runtime(solo: () => unknown[]): Record<string, ApiHandler> {
  return {
    "GET /proxy:/topics": { body: { items: TOPICS } },
    "GET /proxy:/tasks": (request: ApiRequest) => {
      const uri = request.uri || "";
      if (uri.includes("topic_id=_solo")) return { body: { items: solo() } };
      if (uri.includes("topic_id=thread-1")) return { body: { items: [done("tt1", "thread work", "Working on the report in the thread.", "thread-1")] } };
      return { body: { items: [done("t1", "Where to go?", "Try Lisbon.", "topic-1")] } };
    },
    "GET /proxy:/todo/tasks": { body: { tasks: [] } },
  };
}

const START = { kind: "thread", id: "thread-1", label: "Build report", task_id: "tt1", uses: [{ action: "start", count: 1 }] };
const CARD = "id:chat-solo-thread.card";
const CHIP = "id:chat-solo-source-thread";

test("a record's participants are read as identities only: bounds, repeats, old and broken records", () => {
  const read = soloParticipantsOf([
    { ...worker(1, "subagent", " Running "), task: "secret ask", output: "secret", result: "secret", error: "secret", processes: [{ pid: 4242 }], messages: [{ text: "secret" }] },
    { id: "worker-2", kind: "coder", status: "failed" },
    { id: "", name: "Nobody" },
    null,
    "worker-9",
    { ...worker(1, "coder", "done"), name: "Someone else" },
    { id: "worker-3", name: "Zed", kind: "wizard", name_index: -4, avatar_index: "x" },
  ]);
  expect(read).toEqual([
    { id: "worker-1", name: nameOf("en", 1), nameSet: "scientists", nameIndex: 1, avatarIndex: 1, kind: "subagent", status: "running" },
    { id: "worker-2", name: "", kind: "coder", status: "failed" },
    { id: "worker-3", name: "Zed", kind: "subagent", status: "" },
  ]);
  expect(JSON.stringify(read)).not.toContain("secret");
  expect(soloParticipantsOf(undefined)).toEqual([]);
  expect(soloParticipantsOf({ id: "worker-1" })).toEqual([]);
  // No more than the runtime keeps, the newest of them.
  const many = soloParticipantsOf(Array.from({ length: 50 }, (_, index) => worker(index + 1, "subagent", "done", 0, 0)));
  expect(many.length).toBe(32);
  expect(many[0].id).toBe("worker-19");

  const card = (thread: Record<string, unknown>) => soloThreadOf(record("card", "tt1", T1, thread));
  // A record from before participants were kept has none, and shows none.
  expect(card({})?.participants).toEqual([]);
  expect(card({})?.participantsOmitted).toBe(0);
  expect(soloParticipantRoster(card({}), "en")).toEqual({ shown: [], more: 0 });
  expect(card({ participants: "many", participants_omitted: "lots" })?.participants).toEqual([]);
  expect(card({ participants_omitted: -3 })?.participantsOmitted).toBe(0);
  expect(card({ participants_omitted: 2.9 })?.participantsOmitted).toBe(2);
});

test("a roster shows the newest three, newest first, and counts the rest once", () => {
  const thread = (extra: Record<string, unknown>) => soloThreadOf(record("card", "tt1", T1, extra));
  const five = [worker(1, "subagent", "done"), worker(2, "coder", "failed"), worker(3, "subagent", "running"), worker(4, "coder", "running"), worker(5, "subagent", "")];
  const running = soloParticipantRoster(thread({ participants: five, participants_omitted: 30 }), "en");
  expect(running.shown.map((w: any) => `${w.id}/${w.displayName}/${w.kind}/${w.state}`)).toEqual([
    `worker-5/${nameOf("en", 5)}/subagent/running`,
    `worker-4/${nameOf("en", 4)}/coder/running`,
    `worker-3/${nameOf("en", 3)}/subagent/running`,
  ]);
  // Two listed ones are not shown and thirty are no longer listed.
  expect(running.more).toBe(32);
  expect(soloParticipantRoster(thread({ participants: five.slice(0, 3) }), "en").more).toBe(0);
  expect(soloParticipantRoster(thread({ participants: five.slice(0, 2), participants_omitted: 1 }), "en").more).toBe(1);

  // In a thread that ended, a worker still marked live ended with it; one that failed stays failed.
  const states = (state: string) =>
    soloParticipantRoster(thread({ state, participants: five }), "en", 5)
      .shown.map((w: any) => w.state)
      .reverse();
  expect(states("done")).toEqual(["done", "failed", "done", "done", "done"]);
  expect(states("failed")).toEqual(["done", "failed", "failed", "failed", "failed"]);
  expect(states("canceled")).toEqual(["done", "failed", "canceled", "canceled", "canceled"]);
  expect(states("waiting")).toEqual(["done", "failed", "running", "running", "running"]);

  // Names follow the Console's language; a worker without a name or picks shows its ID, in the
  // logo style its ID gives it, and nobody is made up.
  const named = thread({ participants: [worker(1, "subagent", "done"), { id: "worker-9", kind: "coder", status: "done" }, { id: "x7", name: "Custom Name", kind: "subagent" }] });
  expect(soloParticipantRoster(named, "zh").shown.map((w: any) => w.displayName)).toEqual(["Custom Name", "worker-9", nameOf("zh", 1)]);
  expect(soloParticipantRoster(named, "ja").shown.map((w: any) => w.displayName)).toEqual(["Custom Name", "worker-9", nameOf("ja", 1)]);
  expect(nameOf("zh", 1)).not.toBe(nameOf("en", 1));
  expect(soloParticipantRoster(named, "en").shown.map((w: any) => w.avatarStyle)).toEqual([
    workerAvatarStyle({ id: "x7" }),
    workerAvatarStyle({ id: "worker-9" }),
    workerAvatarStyle({ avatarIndex: 1 }),
  ]);
});

test("a thread chip stands for a task only by that task's own loaded record", () => {
  const sources = (list: unknown[]): any[] => soloSourcesOf({ result: { solo_sources: list } });
  // The task a start made is kept on a thread chip, and on no other kind.
  expect(sources([START, { kind: "topic", id: "topic-1", label: "Trip plans", task_id: "tt1" }, { kind: "memory", task_id: "tt1" }])).toEqual([
    { kind: "thread", id: "thread-1", label: "Build report", uses: [{ action: "start", count: 1 }], taskID: "tt1" },
    { kind: "topic", id: "topic-1", label: "Trip plans", uses: [] },
    { kind: "memory", id: "", label: "", uses: [] },
  ]);
  // The same thread listed with two tasks is one chip that names neither, with the uses of both.
  expect(sources([START, { ...START, task_id: "tt2" }, { ...START, task_id: "tt1" }])).toEqual([
    { kind: "thread", id: "thread-1", label: "Build report", uses: [{ action: "start", count: 3 }] },
  ]);
  expect(sources([{ ...START, task_id: undefined }, START])[0].taskID).toBe("tt1");
  expect(sources([START, START])[0].taskID).toBe("tt1");

  const item = (kind: "card" | "summary", taskID: string, thread: Record<string, unknown> = {}) => ({ soloThread: soloThreadOf(record(kind, taskID, T1, thread)) });
  const chip = sources([START])[0];
  const items = [item("summary", "tt1"), item("card", "tt2"), item("card", "tt1"), { soloThread: null }, {}];
  expect(soloThreadOfSource(chip, items)?.kind).toBe("card");
  expect(soloThreadOfSource(chip, items)?.taskID).toBe("tt1");
  // Without the card, the task's summary is still that task's record.
  expect(soloThreadOfSource(chip, [item("summary", "tt1"), item("card", "tt2")])?.kind).toBe("summary");
  // Another task of the same topic and title is not this chip's task.
  expect(soloThreadOfSource(chip, [item("card", "tt2"), item("summary", "tt3")])).toBe(null);
  expect(soloThreadOfSource(chip, [])).toBe(null);
  expect(soloThreadOfSource(chip, undefined)).toBe(null);
  // The same task ID under another topic is not it either.
  expect(soloThreadOfSource(chip, [item("card", "tt1", { topic_id: "thread-9" })])).toBe(null);
  // A chip that names no task, and a chip of another kind, stand for none.
  expect(soloThreadOfSource(sources([{ ...START, task_id: "" }])[0], items)).toBe(null);
  expect(soloThreadOfSource({ kind: "topic", id: "thread-1", taskID: "tt1" }, items)).toBe(null);
});

test("a thread's card shows its task's subagent and coder live, and its summary agrees", async () => {
  let step = 0;
  const solo = () => {
    const participants = [
      [],
      [worker(1, "subagent", "running", 3, 2), worker(2, "coder", "running", 7, 5)],
      [worker(1, "subagent", "done", 3, 2), worker(2, "coder", "failed", 7, 5)],
      // The task ended while the runtime still had the subagent as running.
      [worker(1, "subagent", "running", 3, 2), worker(2, "coder", "failed", 7, 5)],
    ][step];
    const state = step === 3 ? "done" : "running";
    const items: unknown[] = [reply("s1", T0, "I started a thread for the report.", [START, { kind: "workspace", id: "/home/u/proj", label: "~/proj" }, { kind: "memory" }])];
    items.push(record("card", "tt1", T1, { state, ...(participants.length ? { participants } : {}) }));
    if (step === 3) items.push(record("summary", "tt1", T2, { state, summary: "Report ready: **42 pages**", participants }));
    return items;
  };
  const ada = nameOf("en", 3);
  const milo = nameOf("en", 7);
  const { app, calls } = await openConsole({ location: "/e/default/chat/_solo", clock: true, api: runtime(solo) });
  await app.waitFor(`${CARD}.running`);
  // No workers yet: no row on the card and nothing on its chip.
  expect(app.count("id:chat-solo-participants")).toBe(0);
  expect(app.count("id:chat-solo-source-participants")).toBe(0);
  await app.waitFor("label:Thread: Build report");

  // The task starts a subagent and a coder: both are on the card by the next look at the history.
  step = 1;
  await app.clock!.runFor(3000);
  await app.waitFor(`${CARD}.running >> id:chat-solo-participants`);
  await app.waitFor("label:Subagents and coders on this task");
  await app.waitFor(`label:${ada} · Subagent · Running`);
  await app.waitFor(`label:${milo} · Coder · Running`);
  expect(app.shows(`${CARD}.running >> text:${ada}`)).toBe(true);
  expect(app.shows(`${CARD}.running >> text:${milo}`)).toBe(true);
  expect(app.count("id:chat-solo-participant-name")).toBe(2);
  // Each has its own logo style, the one its record picked.
  expect(app.count(`id:chat-solo-participant-avatar.${workerAvatarStyle({ avatarIndex: 2 })}`)).toBe(1);
  expect(app.count(`id:chat-solo-participant-avatar.${workerAvatarStyle({ avatarIndex: 5 })}`)).toBe(1);
  // The newest is first.
  expect(app.texts().indexOf(milo)).toBeLessThan(app.texts().indexOf(ada));
  // The chip of the reply that started this task has their avatars, and says who they are.
  await app.waitFor(`${CHIP} >> id:chat-solo-source-participants`);
  await app.waitFor(`label:Thread: Build report. Worked on by: ${milo} (Coder, Running), ${ada} (Subagent, Running)`);
  expect(app.count(`id:chat-solo-source-participant.coder.${workerAvatarStyle({ avatarIndex: 5 })}`)).toBe(1);
  expect(app.count(`id:chat-solo-source-participant.subagent.${workerAvatarStyle({ avatarIndex: 2 })}`)).toBe(1);
  // The other chips are as they were.
  await app.waitFor("label:Workspace: ~/proj, show details");
  await app.waitFor("label:Memory, show details");
  expect(app.count("id:chat-solo-source-participants")).toBe(1);
  // The agent of the thread is not one of its workers: two workers, two names.
  expect(app.count("id:chat-solo-participant.subagent.running")).toBe(1);
  expect(app.count("id:chat-solo-participant.coder.running")).toBe(1);

  // The subagent finishes and the coder fails while the task goes on.
  step = 2;
  await app.clock!.runFor(3000);
  await app.waitFor(`label:${ada} · Subagent · Done`);
  await app.waitFor(`label:${milo} · Coder · Failed`);
  expect(app.count("id:chat-solo-participant-name")).toBe(2);
  await app.waitFor(`label:Thread: Build report. Worked on by: ${milo} (Coder, Failed), ${ada} (Subagent, Done)`);

  // The task ends: the card and the summary show the same two, and nobody still runs.
  step = 3;
  await app.clock!.runFor(3000);
  await app.waitFor(`${CARD}.done`);
  await app.waitFor("id:chat-solo-thread.summary.done >> id:chat-solo-participants");
  for (const part of [`${CARD}.done`, "id:chat-solo-thread.summary.done"]) {
    expect(app.shows(`${part} >> id:chat-solo-participant.subagent.done`)).toBe(true);
    expect(app.shows(`${part} >> id:chat-solo-participant.coder.failed`)).toBe(true);
    expect(app.shows(`${part} >> text:${ada}`)).toBe(true);
    expect(app.shows(`${part} >> text:${milo}`)).toBe(true);
  }
  expect(app.count("id:chat-solo-participant.subagent.running")).toBe(0);
  // The chip still stands for the card's task, not twice for the card and the summary.
  expect(app.count("id:chat-solo-source-participants")).toBe(1);
  await app.waitFor(`label:Thread: Build report. Worked on by: ${milo} (Coder, Failed), ${ada} (Subagent, Done)`);

  // A participant is not pressed; Open thread and the chip still open the thread.
  await app.press(`${CARD}.done >> id:chat-solo-thread-open`);
  await app.waitFor("text:Working on the report in the thread.");
  expect(calls.some((call) => call.uri?.includes("topic_id=thread-1"))).toBe(true);
  await app.press("id:chat-topic-_solo");
  await app.waitFor(`${CHIP} >> id:chat-solo-source-participants`);
  await app.press(CHIP);
  await app.waitFor("text:Working on the report in the thread.");
});

test("more workers than a card shows are counted, on the card and on the chip", async () => {
  const participants = [worker(1, "subagent", "done"), worker(2, "coder", "done"), worker(3, "subagent", "failed"), worker(4, "coder", "canceled"), worker(5, "subagent", "running")];
  const solo = () => [
    reply("s1", T0, "I started a thread for the report.", [START]),
    record("card", "tt1", T1, { state: "waiting", participants, participants_omitted: 30 }),
  ];
  const { app } = await openConsole({ location: "/e/default/chat/_solo", width: 390, height: 844, api: runtime(solo) });
  await app.waitFor(`${CARD}.waiting >> id:chat-solo-participants`);
  expect(app.count("id:chat-solo-participant-name")).toBe(3);
  expect(app.shows(`${CARD}.waiting >> id:chat-solo-participants >> text:+32`)).toBe(true);
  expect(app.count("id:chat-solo-participants-more")).toBe(1);
  await app.waitFor("label:32 more");
  // A waiting task's workers keep their own states.
  await app.waitFor(`label:${nameOf("en", 5)} · Subagent · Running`);
  await app.waitFor(`label:${nameOf("en", 4)} · Coder · Canceled`);
  await app.waitFor(`label:${nameOf("en", 3)} · Subagent · Failed`);
  expect(app.shows(`text:${nameOf("en", 1)}`)).toBe(false);
  // The chip: three avatars, the same count, and the names in its name.
  const avatar = (n: number, kind: string) => `id:chat-solo-source-participant.${kind}.${workerAvatarStyle({ avatarIndex: n })}`;
  expect([avatar(5, "subagent"), avatar(4, "coder"), avatar(3, "subagent")].map((id) => app.count(id))).toEqual([1, 1, 1]);
  expect([avatar(1, "subagent"), avatar(2, "coder")].map((id) => app.count(id))).toEqual([0, 0]);
  expect(app.shows(`${CHIP} >> id:chat-solo-source-participants >> text:+32`)).toBe(true);
  await app.waitFor(
    `label:Thread: Build report. Worked on by: ${nameOf("en", 5)} (Subagent, Running), ${nameOf("en", 4)} (Coder, Canceled), ${nameOf("en", 3)} (Subagent, Failed), and 32 more`,
  );
  // The chip keeps its own words.
  expect(app.shows(`${CHIP} >> text:Build report`)).toBe(true);
});

test("a chip shows no workers it cannot tie to its own task", async () => {
  const first = [worker(1, "subagent", "done", 3, 2)];
  const second = [worker(1, "coder", "running", 8, 4)];
  const solo = () => [
    // The reply that started the first task, then one that only read the thread, one that gave it
    // more work (the second task), one that started it twice, and one whose task's card is gone.
    reply("s1", T0, "First start.", [START]),
    record("card", "tt1", T1, { state: "done", participants: first }),
    reply("s2", T1, "Read it.", [{ kind: "thread", id: "thread-1", label: "Build report", uses: [{ action: "read", count: 1 }] }]),
    reply("s3", T2, "More work.", [{ ...START, task_id: "tt2" }]),
    record("card", "tt2", T2, { state: "running", continued: true, participants: second }),
    reply("s4", T3, "Twice.", [START, { ...START, task_id: "tt2" }]),
    reply("s5", T3, "Elsewhere.", [{ ...START, task_id: "tt-not-loaded" }, { kind: "topic", id: "thread-1", label: "Build report", task_id: "tt1" }]),
  ];
  const { app } = await openConsole({ location: "/e/default/chat/_solo", api: runtime(solo) });
  await app.waitFor("text:Elsewhere.");
  await app.waitFor(`label:Thread: Build report. Worked on by: ${nameOf("en", 3)} (Subagent, Done)`);
  await app.waitFor(`label:Thread: Build report. Worked on by: ${nameOf("en", 8)} (Coder, Running)`);
  // Five thread chips, two of them with workers: each task's own, never the topic's latest.
  expect(app.count(CHIP)).toBe(5);
  expect(app.count("id:chat-solo-source-participants")).toBe(2);
  expect(app.count("label:Thread: Build report")).toBe(3);
  expect(app.count(`id:chat-solo-source-participant.subagent.${workerAvatarStyle({ avatarIndex: 2 })}`)).toBe(1);
  expect(app.count(`id:chat-solo-source-participant.coder.${workerAvatarStyle({ avatarIndex: 4 })}`)).toBe(1);
  // The two cards of the one topic each have their own task's workers.
  expect(app.shows(`${CARD}.done >> text:${nameOf("en", 3)}`)).toBe(true);
  expect(app.shows(`${CARD}.done >> text:${nameOf("en", 8)}`)).toBe(false);
  expect(app.shows(`${CARD}.running >> text:${nameOf("en", 8)}`)).toBe(true);
  expect(app.shows(`${CARD}.running >> text:${nameOf("en", 3)}`)).toBe(false);
  // A topic chip stays a topic chip.
  await app.waitFor("label:Topic: Build report");
});

for (const lang of ["zh", "ja"] as const) {
  test(`${lang}: participants are named and described in the Console's language`, async () => {
    const words = {
      zh: { row: "参与这项任务的子代理和编码器", sub: "子代理", coder: "编码器", done: "已完成", failed: "失败", more: "另有 2 个" },
      ja: { row: "このタスクに参加したサブエージェントとコーダー", sub: "サブエージェント", coder: "コーダー", done: "完了", failed: "失敗", more: "ほか 2 件" },
    }[lang];
    const participants = [worker(1, "subagent", "done"), worker(2, "coder", "done"), worker(3, "subagent", "done"), worker(4, "coder", "failed"), worker(5, "subagent", "running")];
    const solo = () => [reply("s1", T0, "I started a thread for the report.", [START]), record("card", "tt1", T1, { state: "done", participants })];
    const { app } = await openConsole({ location: "/e/default/chat/_solo", width: 390, height: 844, kv: { "quail-language": lang }, api: runtime(solo) });
    await app.waitFor(`label:${words.row}`);
    await app.waitFor(`label:${nameOf(lang, 5)} · ${words.sub} · ${words.done}`);
    await app.waitFor(`label:${nameOf(lang, 4)} · ${words.coder} · ${words.failed}`);
    await app.waitFor(`label:${words.more}`);
    expect(app.shows(`${CARD}.done >> text:${nameOf(lang, 5)}`)).toBe(true);
    const sep = lang === "zh" ? "，" : "、";
    await app.waitFor(
      lang === "zh"
        ? `label:线程：Build report。参与者：${nameOf(lang, 5)}（${words.sub}${sep}${words.done}）、${nameOf(lang, 4)}（${words.coder}${sep}${words.failed}）、${nameOf(lang, 3)}（${words.sub}${sep}${words.done}）、${words.more}`
        : `label:スレッド：Build report。参加：${nameOf(lang, 5)}（${words.sub}${sep}${words.done}）、${nameOf(lang, 4)}（${words.coder}${sep}${words.failed}）、${nameOf(lang, 3)}（${words.sub}${sep}${words.done}）、${words.more}`,
    );
  });
}
