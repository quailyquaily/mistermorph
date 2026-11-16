// A TODO item's topic folds the scheduled runs that found nothing to do (result.outcome "nothing",
// from the runtime's check): which runs group and what ends a group, the line and what opening it
// shows, a run shown in full in place, the page keeping what is open, the strings in each
// language, and the sidebar following the runtime, which leaves a quiet run's topic where it was.
import type { App } from "nsh/test";
import { expect, test } from "nsh/test";
import { LANGUAGES } from "../components/LanguageSelector";
import { foldQuietRuns, isQuietRunItem, QUIET_RUNS_ROLE, quietRunLine, quietRunsSpan } from "../lib/core/chat-quiet-runs.js";
import { historyTimeLabel, taskListHistoryItems } from "../lib/core/chat-task-history.js";
import { openConsole, type ApiRequest } from "./harness";

const TOPIC = "_cron_job1";
const TASK = "Run a factory build for this repository.";
const QUIET = "No build performed: .factory/new/ is empty. Lock released; no notification sent.";

/** Today at the given time, as the runtime writes it. */
function at(hour: number, minute = 0) {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

function label(iso: string, locale = "en-US") {
  return historyTimeLabel(iso, locale);
}

type Run = Record<string, unknown>;

function run(id: string, hour: number, minute: number, output: string, extra: Run = {}): Run {
  const time = at(hour, minute);
  const { outcome, ...rest } = extra as { outcome?: string };
  return {
    id,
    task: TASK,
    topic_id: TOPIC,
    status: "done",
    created_at: time,
    started_at: time,
    finished_at: time,
    result: { final: { output }, ...(outcome ? { outcome } : {}) },
    ...rest,
  };
}

const quiet = (id: string, hour: number, minute = 0, output = QUIET) => run(id, hour, minute, output, { outcome: "nothing" });

const tr = (key: string) => key;
const itemsOf = (tasks: Run[]) => taskListHistoryItems(tasks, tr, { locale: "en-US" });
/** The rows a conversation shows: "quiet(n)" for a group of n runs, else the item's id. */
const shape = (tasks: Run[]) =>
  (foldQuietRuns(itemsOf(tasks)) as any[]).map((item) => (item.role === QUIET_RUNS_ROLE ? `quiet(${item.runs.length})` : item.id));

test("consecutive quiet runs form one group, one quiet run folds too, and every other run ends a group and stays in full", () => {
  const full = (id: string) => [`${id}:user`, `${id}:agent`];
  for (const [name, tasks, want] of [
    ["one quiet run", [quiet("q1", 9)], ["quiet(1)"]],
    ["consecutive quiet runs", [quiet("q1", 9), quiet("q2", 9, 30), quiet("q3", 10)], ["quiet(3)"]],
    ["a result run", [quiet("q1", 9), run("r", 10, 0, "Built FT138.", { outcome: "result" }), quiet("q2", 11)], ["quiet(1)", ...full("r"), "quiet(1)"]],
    ["a problem run", [quiet("q1", 9), run("p", 10, 0, "Could not reach GitHub.", { outcome: "problem" }), quiet("q2", 11)], ["quiet(1)", ...full("p"), "quiet(1)"]],
    ["an unchecked run (a manual one, or one from before the check)", [quiet("q1", 9), run("u", 10, 0, QUIET), quiet("q2", 11)], ["quiet(1)", ...full("u"), "quiet(1)"]],
    ["an unknown outcome", [quiet("q1", 9), run("x", 10, 0, QUIET, { outcome: "quiet" })], ["quiet(1)", ...full("x")]],
    ["a run in progress", [quiet("q1", 9), run("w", 10, 0, "", { status: "running", finished_at: "", result: { outcome: "nothing" } })], ["quiet(1)", ...full("w")]],
    ["a failed run", [quiet("q1", 9), run("f", 10, 0, "", { status: "failed", error: "model unavailable", result: { outcome: "nothing" } }), quiet("q2", 11)], ["quiet(1)", ...full("f"), "quiet(1)"]],
    ["a stopped run", [run("c", 9, 0, "", { status: "canceled", result: { outcome: "nothing" } }), quiet("q1", 10), quiet("q2", 11)], [...full("c"), "quiet(2)"]],
    ["runs given out of order", [quiet("q3", 11), quiet("q1", 9), run("r", 10, 0, "Built.", { outcome: "result" })], ["quiet(1)", ...full("r"), "quiet(1)"]],
    ["no quiet run", [run("r", 9, 0, "Built.", { outcome: "result" }), run("u", 10, 0, QUIET)], [...full("r"), ...full("u")]],
    ["a quiet run of another kind of topic", [{ ...quiet("q1", 9), topic_id: "topic-1" }, { ...quiet("q2", 10), topic_id: "" }], [...full("q1"), ...full("q2")]],
  ] as [string, Run[], string[]][]) {
    expect({ name, rows: shape(tasks) }).toEqual({ name, rows: want });
  }
  // Nothing to fold: the same array, so a conversation without quiet runs is untouched.
  const plain = itemsOf([run("r", 9, 0, "Built.", { outcome: "result" })]);
  expect(foldQuietRuns(plain)).toBe(plain);
  expect(foldQuietRuns(undefined as never)).toEqual([]);
});

test("a group is named by its first run, keeps each run's two messages, and says its time span", () => {
  const tasks = [quiet("q1", 9), quiet("q2", 9, 30, "Nothing in review/.\n\nNo changes   made."), quiet("q3", 12, 30)];
  const [group] = foldQuietRuns(itemsOf(tasks)) as any[];
  expect(group.id).toBe("quiet:q1");
  expect(group.runs.map((entry: any) => [entry.id, entry.user?.id, entry.agent.id, entry.at])).toEqual([
    ["q1", "q1:user", "q1:agent", label(at(9))],
    ["q2", "q2:user", "q2:agent", label(at(9, 30))],
    ["q3", "q3:user", "q3:agent", label(at(12, 30))],
  ]);
  // The reply as one line.
  expect(group.runs[1].text).toBe("Nothing in review/. No changes made.");
  expect(quietRunLine("a".repeat(400)).length).toBeLessThan(260);
  expect(quietRunsSpan(group)).toBe(`${label(at(9))} – ${label(at(12, 30))}`);
  expect(quietRunsSpan((foldQuietRuns(itemsOf([quiet("q1", 9)])) as any[])[0])).toBe(label(at(9)));
  // A new quiet run joins the group without renaming it; a full run after it starts another.
  const more = foldQuietRuns(itemsOf([...tasks, quiet("q4", 13), run("r", 14, 0, "Built.", { outcome: "result" }), quiet("q5", 15)])) as any[];
  expect(more.map((item) => item.id)).toEqual(["quiet:q1", "r:user", "r:agent", "quiet:q5"]);
  expect(more[0].runs.length).toBe(4);
  // A run without a task message (its text was empty) still folds, by its reply alone.
  const bare = foldQuietRuns(itemsOf([{ ...quiet("q1", 9), task: "" }])) as any[];
  expect(bare.map((item) => item.id)).toEqual(["quiet:q1"]);
  expect(bare[0].runs[0].user).toBe(null);
  expect(isQuietRunItem(bare[0].runs[0].agent)).toBe(true);
});

const TOPICS = [{ id: TOPIC, title: "Factory build", created_at: at(8), updated_at: at(8) }];

function api(tasks: () => Run[], extra: Record<string, unknown> = {}) {
  return {
    "GET /proxy:/topics": { body: { items: TOPICS } },
    "GET /proxy:/tasks": (request: ApiRequest) => ({ body: { items: (request.uri || "").includes(`topic_id=${TOPIC}`) ? tasks() : [] } }),
    "GET /proxy:/todo/tasks": { body: { tasks: [{ id: "job1", llm_profile: "" }] } },
    ...extra,
  } as never;
}

const lineLabel = (count: number, from: string, to = from) =>
  `label:${count} run${count === 1 ? "" : "s"}, nothing to do, ${from === to ? label(from) : `${label(from)} – ${label(to)}`}`;
const rowLabel = (iso: string, text = QUIET) => `label:${label(iso)} ${text}`;
const shownTimes = (app: App) => app.count("id:chat-quiet-run");

test("the topic draws each group as one line, and runs that came to something in full", async () => {
  const tasks = [
    run("built", 8, 30, "Built FT138. Tests pass.", { outcome: "result" }),
    quiet("q1", 9),
    quiet("q2", 9, 30),
    quiet("q3", 10),
    run("manual", 10, 30, "No build performed: asked by hand."),
    quiet("q4", 11),
    run("problem", 11, 30, "Could not reach the remote.", { outcome: "problem" }),
  ];
  const { app } = await openConsole({ location: `/e/default/chat/${TOPIC}`, api: api(() => tasks) });
  await app.waitFor("text:Built FT138. Tests pass.");
  // Two groups: three runs, and one run by itself between two full runs.
  expect(app.count("id:chat-quiet-runs-line")).toBe(2);
  await app.waitFor(lineLabel(3, at(9), at(10)));
  await app.waitFor(lineLabel(1, at(11)));
  expect(app.texts()).toContain("3 runs, nothing to do");
  expect(app.texts()).toContain("1 run, nothing to do");
  expect(app.texts()).toContain(`${label(at(9))} – ${label(at(10))}`);
  // Folded, nothing of the quiet runs is drawn: no reply, and no task message of theirs.
  expect(app.shows(`text:${QUIET}`)).toBe(false);
  expect(app.count("id:chat-quiet-run")).toBe(0);
  expect(app.count("id:chat-user-bubble")).toBe(3);
  expect(app.count("id:chat-item-agent")).toBe(3);
  // The full runs are as before.
  await app.waitFor("text:No build performed: asked by hand.");
  await app.waitFor("text:Could not reach the remote.");
});

test("pressing the line opens the group, a row shows its run in full in place, and the page keeps what is open as runs join", async () => {
  let tasks = [run("built", 8, 30, "Built FT138.", { outcome: "result" }), quiet("q1", 9), quiet("q2", 9, 30, "Nothing in review/."), quiet("q3", 10)];
  const { app } = await openConsole({ location: `/e/default/chat/${TOPIC}`, clock: true, api: api(() => tasks) });
  await app.waitFor("text:Built FT138.");
  const line = lineLabel(3, at(9), at(10));
  await app.waitFor(line);
  expect(app.count("id:chat-quiet-runs-list")).toBe(0);

  await app.press(line);
  await app.waitFor("id:chat-quiet-runs-list");
  // One row per run: its time and its reply; the task's message is not repeated.
  expect(shownTimes(app)).toBe(3);
  await app.waitFor(rowLabel(at(9)));
  await app.waitFor(rowLabel(at(9, 30), "Nothing in review/."));
  await app.waitFor(rowLabel(at(10)));
  expect(app.count("id:chat-user-bubble")).toBe(1);
  expect(app.count("id:chat-quiet-run-full")).toBe(0);

  // A row pressed shows that run as it looks unfolded, under the row; the others stay rows.
  await app.press(rowLabel(at(9, 30), "Nothing in review/."));
  await app.waitFor("id:chat-quiet-run-full");
  expect(app.count("id:chat-quiet-run-full")).toBe(1);
  expect(app.count("id:chat-quiet-run-full >> id:chat-user-bubble")).toBe(1);
  expect(app.count(`id:chat-quiet-run-full >> text:${TASK}`)).toBe(1);
  expect(app.count("id:chat-quiet-run-full >> id:chat-item-agent")).toBe(1);
  await app.waitFor("id:chat-quiet-run-full >> text:Nothing in review/.");
  expect(shownTimes(app)).toBe(3);

  // The topic looks for new runs while open: another quiet run joins the group, which stays open,
  // with the run shown in full still shown.
  tasks = [...tasks, quiet("q4", 10, 30)];
  await app.clock!.runFor(5000);
  await app.waitFor(lineLabel(4, at(9), at(10, 30)));
  expect(app.count("id:chat-quiet-runs-line")).toBe(1);
  expect(shownTimes(app)).toBe(4);
  expect(app.count("id:chat-quiet-run-full")).toBe(1);

  // Pressed again, the row folds its run; pressed again, the line folds the group.
  await app.press(rowLabel(at(9, 30), "Nothing in review/."));
  await app.waitFor("id:chat-quiet-run-full", { state: "gone" });
  await app.press(lineLabel(4, at(9), at(10, 30)));
  await app.waitFor("id:chat-quiet-runs-list", { state: "gone" });
  expect(shownTimes(app)).toBe(0);

  // A run that came to something ends the group: the next quiet run starts a new, folded one,
  // and the first group opens as it was left (its run shown in full was folded).
  tasks = [...tasks, run("built-2", 11, 0, "Built FT139.", { outcome: "result" }), quiet("q5", 11, 30)];
  await app.clock!.runFor(5000);
  await app.waitFor("text:Built FT139.");
  expect(app.count("id:chat-quiet-runs-line")).toBe(2);
  await app.waitFor(lineLabel(1, at(11, 30)));
  await app.press(lineLabel(1, at(11, 30)));
  await app.waitFor(rowLabel(at(11, 30)));
  expect(shownTimes(app)).toBe(1);
});

test("a run still in progress is shown in full, and folds once the runtime marks it quiet", async () => {
  let tasks = [quiet("q1", 9), run("w", 9, 30, "", { status: "running", finished_at: "", result: null })];
  const { app } = await openConsole({
    location: `/e/default/chat/${TOPIC}`,
    clock: true,
    api: api(() => tasks, { "GET /proxy:/tasks/w": () => ({ body: tasks.find((task) => task.id === "w") }) }),
  });
  await app.waitFor(lineLabel(1, at(9)));
  expect(app.count("id:chat-item-agent")).toBe(1);
  expect(app.count("id:chat-user-bubble")).toBe(1);
  tasks = [quiet("q1", 9), quiet("w", 9, 30)];
  await app.clock!.runFor(5000);
  await app.waitFor(lineLabel(2, at(9), at(9, 30)));
  expect(app.count("id:chat-quiet-runs-line")).toBe(1);
  expect(app.count("id:chat-item-agent")).toBe(0);
  expect(app.count("id:chat-user-bubble")).toBe(0);
});

test("the line reads in every language the Console has", async () => {
  const want: Record<string, [string, string]> = {
    en: ["1 run, nothing to do", "3 runs, nothing to do"],
    zh: ["1 次运行，无事可做", "3 次运行，无事可做"],
    ja: ["1 回の実行、対応なし", "3 回の実行、対応なし"],
  };
  // A language added to the Console needs the strings too.
  expect(LANGUAGES.map((language) => language.value).sort()).toEqual(Object.keys(want).sort());
  const tasks = [quiet("q1", 9), run("built", 9, 30, "Built FT138.", { outcome: "result" }), quiet("q2", 10), quiet("q3", 10, 30), quiet("q4", 11)];
  for (const lang of Object.keys(want)) {
    const { app } = await openConsole({ location: `/e/default/chat/${TOPIC}`, kv: { "quail-language": lang }, api: api(() => tasks) });
    await app.waitFor("text:Built FT138.");
    await app.waitUntil(() => app.count("id:chat-quiet-runs-line") === 2);
    const texts = app.texts();
    expect({ lang, one: texts.includes(want[lang][0]), many: texts.includes(want[lang][1]) }).toEqual({ lang, one: true, many: true });
    expect(texts.some((text) => text.includes("chat_quiet_runs"))).toBe(false);
  }
});

test("a quiet run leaves its topic where it was in the TODO list and unmarked; a run that came to something moves and marks it", async () => {
  // What the runtime reports (internal/daemonruntime): a quiet run changes neither the topic's
  // updated_at nor its latest completion.
  const OTHER = "_cron_job2";
  const state = {
    topics: [
      { id: TOPIC, title: "Factory build", created_at: at(7), updated_at: at(7) },
      { id: OTHER, title: "Daily digest", created_at: at(8), updated_at: at(8) },
    ],
    activity: [
      { id: TOPIC, status: "", running: 0, pending: 0, latest_done_task_id: "built", latest_done_at: at(7) },
      { id: OTHER, status: "", running: 0, pending: 0, latest_done_task_id: "digest", latest_done_at: at(8) },
    ],
  };
  const { app } = await openConsole({
    location: `/e/default/chat/${OTHER}`,
    clock: true,
    api: {
      "GET /proxy:/topics": () => ({ body: { items: state.topics } }),
      "GET /proxy:/topics/activity": () => ({ body: { topics: state.activity } }),
      "GET /proxy:/tasks": { body: { items: [] } },
      "GET /proxy:/todo/tasks": { body: { tasks: [{ id: "job1", llm_profile: "" }, { id: "job2", llm_profile: "" }] } },
    } as never,
  });
  await app.waitFor("id:chat-topic-_cron_job1");
  const order = () => {
    const texts = app.texts();
    return texts.indexOf("Daily digest") < texts.indexOf("Factory build") ? "digest, build" : "build, digest";
  };
  await app.waitUntil(() => app.texts().includes("Daily digest") && app.texts().includes("Factory build"));
  expect(order()).toBe("digest, build");
  expect(app.count("id:chat-topic-status-done")).toBe(0);

  // A quiet run of the factory build ends: the runtime reports the same as before.
  await app.clock!.runFor(11000);
  expect(order()).toBe("digest, build");
  expect(app.count("id:chat-topic-status-done")).toBe(0);

  // A run of it that built something ends: its topic moves up and is marked unread.
  state.topics = [{ ...state.topics[0], updated_at: at(9) }, state.topics[1]];
  state.activity = [{ ...state.activity[0], latest_done_task_id: "built-2", latest_done_at: at(9) }, state.activity[1]];
  await app.clock!.runFor(65000);
  await app.waitUntil(() => order() === "build, digest");
  await app.waitFor("id:chat-topic-status-done");
  expect(app.count("id:chat-topic-status-done")).toBe(1);
});
