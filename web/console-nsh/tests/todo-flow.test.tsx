// The Flow view (components/todo/TodoFlow.tsx) on a stand-in page (tests/fixtures/todo-flow-app.tsx):
// a job selected keeps its line and fades the rest; link mode marks who may use a job and never
// offers a loop; a link's picker changes its kind and removes it; the join rule switches; a replay
// travels a column at a time; a phone reads and edits nothing; and forty jobs with sixty links lie
// where the layout says, none over another. The layout itself: tests/todo-flow-layout.test.tsx.
//
// A headless run draws nothing: what a line looks like is in its test id
// (`todo-flow-line-<used>><job>.<tone>.<pulse>`), fading is the views' opacity, and where
// things lie is their measured frames. A step ends only once the app is quiet, so what happens on
// the way (a replay's steps, the links going out while jobs glide) is read from the view's events.
import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";
import { FLOW_DESKTOP, FLOW_PHONE, layoutFlow, type FlowBox, type FlowLayoutJob } from "../components/todo/flow-layout";

type Frame = { x: number; y: number; w: number; h: number };

async function openFlow(options: { width?: number; platform?: "linux" | "android"; reducedMotion?: boolean } = {}) {
  const app = await open("./fixtures/todo-flow-app.tsx", {
    width: options.width ?? 1280,
    height: 900,
    platform: options.platform ?? "linux",
    locale: "en-US",
    reducedMotion: options.reducedMotion,
  });
  await app.waitFor("id:todo-flow-job-report");
  return app;
}

const line = (app: App, start: string) => app.texts().find((text) => text.startsWith(start))?.slice(start.length) ?? "";
const calls = (app: App) => JSON.parse(line(app, "calls:") || "[]") as string[];
const events = (app: App) => (JSON.parse(line(app, "events:") || "[]") as string[]).map((event) => ({ name: event.slice(0, event.lastIndexOf("@")), since: Number(event.slice(event.lastIndexOf("@") + 1)) }));
const frames = (app: App) => JSON.parse(line(app, "frames:") || "{}") as Record<string, Frame>;
/** The fixture's jobs as the layout reads them, from its `uses:` line. */
const jobsOf = (app: App): (FlowLayoutJob & { join: string })[] =>
  line(app, "uses:")
    .split(" ")
    .map((item) => {
      const [id, rest] = item.split("<");
      const [uses, join] = rest.split("/");
      return { id, join, uses: uses ? uses.split("+").map((use) => ({ job_id: use })) : [] };
    });
/** How visible a job is: its own opacity times every view's around it. */
const shown = (app: App, id: string) => Math.round((app.viewStyle(`id:todo-flow-node-${id}`)?.effectiveOpacity ?? -1) * 100) / 100;
const lineOpacity = (app: App, id: string) => Math.round((app.viewStyle(`id:${id}`)?.effectiveOpacity ?? -1) * 100) / 100;
const PROTO = ["report", "digest", "risk", "brief", "peer", "notes", "triage", "heartbeat", "backup"];
const fadedJobs = (app: App) => PROTO.filter((id) => shown(app, id) < 1).sort();

test("a job selected keeps everything up and down its line in ink and fades the rest", async () => {
  const app = await openFlow();
  // No run under way: lines carry no pulse.
  await app.press("id:stop");
  expect(fadedJobs(app)).toEqual([]);
  expect(app.count("id:todo-flow-open-digest")).toBe(0);

  await app.press("id:todo-flow-job-digest");
  // Up the line: Morning report; down it: Weekly brief. Risk summary feeds the brief but is on neither.
  expect(fadedJobs(app)).toEqual(["backup", "heartbeat", "notes", "peer", "risk", "triage"]);
  expect(shown(app, "risk")).toBe(0.32);
  expect(app.count("id:todo-flow-line-report>digest.ink.none")).toBe(1);
  expect(app.count("id:todo-flow-line-digest>brief.ink.none")).toBe(1);
  expect(lineOpacity(app, "todo-flow-line-report>digest.ink.none")).toBe(1);
  for (const id of ["todo-flow-line-report>risk.rest.none", "todo-flow-line-risk>brief.rest.none", "todo-flow-line-report>peer.rest.none", "todo-flow-line-report>notes.rest.none"]) {
    expect(app.count(`id:${id}`)).toBe(1);
    expect(lineOpacity(app, id)).toBe(0.25);
  }
  // The selected job is the lighter paper, and says so to screen readers.
  expect(app.viewStyle("id:todo-flow-job-digest")?.backgroundColor).toBe("#ffffffff");
  expect(app.viewStyle("id:todo-flow-job-report")?.backgroundColor).toBe("#fcfcffff");

  // Opening is its own action, on the selected job only.
  expect(app.count("id:todo-flow-open-digest")).toBe(1);
  expect(app.count("id:todo-flow-open-report")).toBe(0);
  expect(calls(app)).toEqual([]);
  await app.press("label:Open Team digest");
  expect(calls(app)).toEqual(["open(digest)"]);

  // Another job takes the selection; the same job again lets it go.
  await app.press("id:todo-flow-job-heartbeat");
  expect(fadedJobs(app)).toEqual(PROTO.filter((id) => id !== "heartbeat").sort());
  await app.press("id:todo-flow-job-heartbeat");
  expect(fadedJobs(app)).toEqual([]);

  // Empty space clears it, and so does Escape.
  await app.press("id:todo-flow-job-brief");
  expect(fadedJobs(app)).toEqual(["backup", "heartbeat", "notes", "peer", "triage"]);
  await app.press("id:todo-flow-ground");
  expect(fadedJobs(app)).toEqual([]);
  expect(app.count("id:todo-flow-open-brief")).toBe(0);
  await app.press("id:todo-flow-job-report");
  expect(fadedJobs(app)).toEqual(["backup", "heartbeat", "triage"]);
  await app.keyboard.press("escape");
  expect(fadedJobs(app)).toEqual([]);
});

test("jobs and links are named for screen readers, and a mark's state is not repeated in words on screen", async () => {
  const app = await openFlow();
  expect(app.count("label:Morning report, running, Weekdays 09:00 or when poked")).toBe(1);
  expect(app.count("label:Check the backups, off, Every day at 02:00")).toBe(1);
  expect(app.count("label:Team digest, Tells Slack #team")).toBe(1);
  expect(app.count("label:Team digest runs each time Morning report finishes, with that result")).toBe(1);
  expect(app.count("label:Answer build questions runs each time Morning report finishes, with that result")).toBe(1);
  expect(app.count("label:Draft release notes runs each time Morning report finishes, with that result")).toBe(1);
  expect(app.count("label:Weekly brief runs when all have finished")).toBe(1);
  // The ring and the hollow mark say running and off: no word beside them.
  for (const word of ["running", "Running", "off", "Off"]) expect(app.texts()).not.toContain(word);
});

test("while a job runs, a pulse runs along its links and no others", async () => {
  const app = await openFlow();
  expect(app.count("id:todo-flow-line-report>digest.rest.live")).toBe(1);
  expect(app.count("id:todo-flow-line-report>risk.rest.live")).toBe(1);
  expect(app.count("id:todo-flow-line-report>peer.rest.live")).toBe(1);
  expect(app.count("id:todo-flow-line-report>notes.rest.live")).toBe(1);
  // Not from a job that is not running.
  expect(app.count("id:todo-flow-line-digest>brief.rest.none")).toBe(1);
  await app.press("id:stop");
  expect(app.count("id:todo-flow-line-report>digest.rest.none")).toBe(1);
  expect(app.count("id:todo-flow-line-report>risk.rest.none")).toBe(1);
});

test("link mode marks the jobs that may use a job, never one that would close a loop or uses it already", async () => {
  const app = await openFlow();
  await app.press("id:stop");
  // Every job has its port (shown under the pointer, and on the selected job): a drag from it
  // draws a link, a press starts link mode.
  expect(app.count("id:todo-flow-link-from-brief")).toBe(1);
  expect(app.count("id:todo-flow-drag-off")).toBe(1);
  await app.press("id:todo-flow-job-brief");
  expect(app.count("label:Let another job use Weekly brief")).toBe(1);
  expect(app.count("id:todo-flow-hint")).toBe(0);
  await app.press("id:todo-flow-link-from-brief");
  expect(app.texts()).toContain("Choose the job that should use Weekly brief. Jobs it already depends on cannot be chosen.");
  expect(app.count("label:Cancel the new link")).toBe(1);
  // Weekly brief depends on Team digest and Risk summary, and through them on Morning report.
  for (const id of ["digest", "risk", "report"]) {
    expect(app.enabled(`id:todo-flow-job-${id}`)).toBe(false);
    expect(shown(app, id)).toBe(0.32);
    await expect(app.press(`id:todo-flow-job-${id}`)).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  }
  for (const id of ["peer", "notes", "triage", "heartbeat", "backup"]) {
    expect(app.enabled(`id:todo-flow-job-${id}`)).toBe(true);
    expect(shown(app, id)).toBe(1);
  }
  expect(app.count("label:Let Heartbeat use Weekly brief")).toBe(1);
  // Every link steps back, and none opens a picker meanwhile.
  expect(lineOpacity(app, "todo-flow-line-report>digest.ink.none")).toBe(0.25);
  expect(lineOpacity(app, "todo-flow-line-report>peer.rest.none")).toBe(0.25);
  expect(app.count("label:Team digest runs each time Morning report finishes, with that result")).toBe(1);
  expect(calls(app)).toEqual([]);

  // Escape leaves link mode and keeps the selection.
  await app.keyboard.press("escape");
  expect(app.count("id:todo-flow-hint")).toBe(0);
  expect(app.count("id:todo-flow-open-brief")).toBe(1);
  expect(app.enabled("id:todo-flow-job-digest")).toBe(true);

  // The button again cancels it too.
  await app.press("id:todo-flow-link-from-brief");
  expect(app.count("id:todo-flow-hint")).toBe(1);
  await app.press("label:Cancel the new link");
  expect(app.count("id:todo-flow-hint")).toBe(0);

  // A job that uses it already is no target: Team digest for Morning report.
  await app.press("id:todo-flow-job-report");
  await app.press("id:todo-flow-link-from-report");
  for (const id of ["digest", "risk", "peer", "notes"]) expect(app.enabled(`id:todo-flow-job-${id}`)).toBe(false);
  // Weekly brief does not use it directly: it may.
  for (const id of ["brief", "triage", "heartbeat", "backup"]) expect(app.enabled(`id:todo-flow-job-${id}`)).toBe(true);
  expect(calls(app)).toEqual([]);
});

test("choosing a target asks for the link, the jobs take their new places with the links out, and its picker opens", async () => {
  const app = await openFlow();
  await app.press("id:stop");
  const before = frames(app);
  await app.press("id:todo-flow-job-brief");
  await app.press("id:todo-flow-link-from-brief");
  await app.press("label:Let Triage family requests use Weekly brief");
  expect(calls(app)).toEqual(["add(triage,brief)"]);
  expect(jobsOf(app).find((item) => item.id === "triage")?.uses).toEqual([{ job_id: "brief" }]);
  // Link mode is over; the job that now uses it is the selected one.
  expect(app.count("id:todo-flow-hint")).toBe(0);
  expect(app.count("id:todo-flow-open-triage")).toBe(1);
  // The links went out while the jobs moved and came back after the glide (380ms).
  await app.waitUntil(() => events(app).length === 3);
  const log = events(app).filter((event) => event.name.startsWith("links:"));
  expect(log.map((event) => event.name)).toEqual(["links:in", "links:out", "links:in"]);
  expect(log[2].since).toBeGreaterThanOrEqual(370);
  expect(log[2].since).toBeLessThan(900);
  // Triage family requests stands a column after Weekly brief now, where the layout says.
  const canvas = frames(app).canvas;
  const layout = layoutFlow(jobsOf(app));
  const triage = layout.nodes.find((node) => node.id === "triage");
  expect(triage?.col).toBe(3);
  await app.waitUntil(() => frames(app)["job-triage"].x !== before["job-triage"].x);
  expect(frames(app)["job-triage"].x - canvas.x).toBe((triage?.x ?? 0) + 14);
  expect(frames(app)["job-triage"].y - canvas.y).toBe((triage?.y ?? 0) + 14);
  expect(frames(app)["job-triage"].x).toBeGreaterThan(before["job-brief"].x + 228);
  expect(app.count("id:todo-flow-line-brief>triage.ink.none")).toBe(1);
  // The new link's picker is open.
  await app.waitFor("text:Remove this link");
  await app.keyboard.press("escape");
  await app.waitFor("text:Remove this link", { state: "gone" });
  // Now Weekly brief depends on nothing new, but Triage depends on it: no loop back.
  await app.press("id:todo-flow-ground");
  await app.press("id:todo-flow-job-triage");
  await app.press("id:todo-flow-link-from-triage");
  for (const id of ["brief", "digest", "risk", "report"]) expect(app.enabled(`id:todo-flow-job-${id}`)).toBe(false);
  expect(app.enabled("id:todo-flow-job-heartbeat")).toBe(true);
});

test("a link's picker removes it, through the page, and offers no kinds", async () => {
  const app = await openFlow();
  await app.press("id:stop");
  expect(app.count("text:Remove this link")).toBe(0);
  await app.press("label:Answer build questions runs each time Morning report finishes, with that result");
  await app.waitFor("text:Remove this link");
  // A link is one thing: there is no kind to choose.
  for (const text of ["Each new result", "Its latest result", "A fresh result"]) expect(app.texts()).not.toContain(text);
  // Opening a link's picker selects the job that uses it.
  expect(app.count("id:todo-flow-open-peer")).toBe(1);
  await app.press("text:Remove this link");
  await app.waitFor("text:Remove this link", { state: "gone" });
  expect(calls(app)).toEqual(["remove(peer,report)"]);
  expect(jobsOf(app).find((item) => item.id === "peer")?.uses).toEqual([]);
  expect(app.count("id:todo-flow-link-report>peer")).toBe(0);
  // Answer build questions uses nothing now: it stands in the first column.
  await app.waitUntil(() => frames(app)["job-peer"].x - frames(app).canvas.x < 100);
  expect(frames(app)["job-peer"].x - frames(app).canvas.x).toBe(14);
});

test("a job that uses more than one job shows its join rule, and a press switches it", async () => {
  const app = await openFlow();
  // Weekly brief has two; no other job has more than one.
  expect(app.count("id:todo-flow-join-brief")).toBe(1);
  for (const id of PROTO.filter((item) => item !== "brief")) expect(app.count(`id:todo-flow-join-${id}`)).toBe(0);
  expect(app.texts()).toContain("runs when all have finished");
  await app.press("id:todo-flow-join-brief");
  expect(calls(app)).toEqual(["join(brief,any)"]);
  expect(app.texts()).toContain("runs when any one finishes");
  expect(app.texts()).not.toContain("runs when all have finished");
  await app.press("label:Weekly brief runs when any one finishes");
  expect(calls(app)).toEqual(["join(brief,any)", "join(brief,all)"]);
  expect(app.texts()).toContain("runs when all have finished");
  // One of its two inputs removed: a single input has no rule to show.
  await app.press("id:todo-flow-link-risk>brief");
  await app.waitFor("text:Remove this link");
  await app.press("text:Remove this link");
  await app.waitFor("id:todo-flow-join-brief", { state: "gone" });
});

test("while a save is under way nothing can be edited, and reading goes on", async () => {
  const app = await openFlow();
  await app.press("id:stop");
  await app.press("id:todo-flow-job-brief");
  expect(app.count("id:todo-flow-link-from-brief")).toBe(1);
  await app.press("id:busy");
  // No link button; the join rule is words, not a control; a link's picker does not open.
  expect(app.count("id:todo-flow-link-from-brief")).toBe(0);
  expect(app.count("label:Weekly brief runs when all have finished")).toBe(0);
  expect(app.texts()).toContain("runs when all have finished");
  // Selecting and opening still work.
  expect(fadedJobs(app)).toEqual(["backup", "heartbeat", "notes", "peer", "triage"]);
  await app.press("label:Open Weekly brief");
  expect(calls(app)).toEqual(["open(brief)"]);
  // A save that starts in link mode ends it.
  await app.press("id:busy");
  await app.press("id:todo-flow-link-from-brief");
  expect(app.count("id:todo-flow-hint")).toBe(1);
  await app.press("id:busy");
  expect(app.count("id:todo-flow-hint")).toBe(0);
  expect(app.enabled("id:todo-flow-job-digest")).toBe(true);
  // A link's target is still there and named, but opens nothing (the press falls to the ground).
  expect(app.count("label:Team digest runs each time Morning report finishes, with that result")).toBe(1);
  await app.press("id:todo-flow-link-report>digest");
  await app.wait(200);
  expect(app.count("text:Remove this link")).toBe(0);
  expect(calls(app)).toEqual(["open(brief)"]);
});

test("a replay travels a column at a time: pulses into the next jobs, none out of a job that failed", async () => {
  const app = await openFlow();
  await app.press("id:todo-flow-job-digest");
  await app.press("id:replay");
  // The steps on the way: Morning report, then the two that use it, then Weekly brief; 620ms apart.
  const steps = events(app).filter((event) => event.name.startsWith("step:"));
  expect(steps.map((event) => event.name)).toEqual(["step:0:report", "step:1:report+digest+risk", "step:2:report+digest+risk+brief"]);
  for (const step of steps.slice(1)) {
    expect(step.since).toBeGreaterThanOrEqual(600);
    expect(step.since).toBeLessThan(1000);
  }
  // At its end: the chain's jobs in ink, the others faded; the selection gave way to it.
  expect(fadedJobs(app)).toEqual(["backup", "heartbeat", "notes", "peer", "triage"]);
  expect(app.count("id:todo-flow-open-digest")).toBe(0);
  // A reached job's second line is its step's note.
  for (const text of ["Today 09:00, by schedule", "Finished", "Failed: the model timed out", "Skipped: Risk summary failed"]) expect(app.texts()).toContain(text);
  for (const text of ["Weekdays 09:00 or when poked", "Tells Slack #team", "Tells Console User", "Tells Slack #leads"]) expect(app.texts()).not.toContain(text);
  expect(app.texts()).toContain("When Lucy asks over Agent Link");
  // Pulses ran along the links out of jobs that finished; the link out of the one that failed is
  // the danger colour and carried none; links the chain did not take are dimmed.
  expect(app.count("id:todo-flow-line-report>digest.ink.replay")).toBe(1);
  expect(app.count("id:todo-flow-line-report>risk.ink.replay")).toBe(1);
  expect(app.count("id:todo-flow-line-digest>brief.ink.replay")).toBe(1);
  expect(app.count("id:todo-flow-line-risk>brief.danger.none")).toBe(1);
  expect(app.count("id:todo-flow-line-report>peer.dim.none")).toBe(1);
  expect(lineOpacity(app, "todo-flow-line-report>peer.dim.none")).toBe(0.25);
  // The job that failed says so to screen readers (its mark turned the danger colour); the running
  // job's mark is its own state again, not the ring.
  expect(app.count("label:Risk summary, failed, Failed: the model timed out")).toBe(1);
  expect(app.count("label:Morning report, Today 09:00, by schedule")).toBe(1);
  // Nothing is edited from a replay: no join rule, no link button, no picker. A job can still be
  // selected, to open it (the one that failed), and the picture stays the chain's.
  expect(app.count("id:todo-flow-join-brief")).toBe(0);
  await app.press("id:todo-flow-job-risk");
  expect(app.count("id:todo-flow-link-from-risk")).toBe(0);
  expect(fadedJobs(app)).toEqual(["backup", "heartbeat", "notes", "peer", "triage"]);
  await app.press("label:Open Risk summary");
  expect(calls(app)).toEqual(["open(risk)"]);
  expect(app.count("label:Weekly brief runs each time Team digest finishes, with that result")).toBe(1);
  await app.press("id:todo-flow-link-digest>brief");
  await app.wait(200);
  expect(app.count("text:Remove this link")).toBe(0);

  // Back to now, with nothing selected.
  await app.press("id:live");
  expect(fadedJobs(app)).toEqual([]);
  expect(app.count("id:todo-flow-open-risk")).toBe(0);
  expect(app.texts()).toContain("Tells Slack #team");
  expect(app.texts()).not.toContain("Finished");
  expect(app.count("id:todo-flow-line-report>digest.rest.live")).toBe(1);
  expect(app.count("id:todo-flow-join-brief")).toBe(1);
});

test("with reduced motion a replay shows where the chain ended at once, and nothing travels", async () => {
  const app = await openFlow({ reducedMotion: true });
  // No live pulse either.
  expect(app.count("id:todo-flow-line-report>digest.rest.none")).toBe(1);
  await app.press("id:replay");
  expect(events(app).filter((event) => event.name.startsWith("step:")).map((event) => event.name)).toEqual(["step:2:report+digest+risk+brief"]);
  expect(fadedJobs(app)).toEqual(["backup", "heartbeat", "notes", "peer", "triage"]);
  expect(app.count("id:todo-flow-line-report>digest.ink.none")).toBe(1);
  expect(app.count("id:todo-flow-line-risk>brief.danger.none")).toBe(1);
  // A new link: the jobs are in their new places at once, and the links never go out.
  await app.press("id:live");
  await app.press("id:todo-flow-job-heartbeat");
  await app.press("id:todo-flow-link-from-heartbeat");
  await app.press("id:todo-flow-job-backup");
  expect(calls(app)).toEqual(["add(backup,heartbeat)"]);
  expect(events(app).map((event) => event.name).filter((name) => name === "links:out")).toEqual([]);
  await app.waitUntil(() => frames(app)["job-backup"].x - frames(app).canvas.x > 100);
  expect(frames(app)["job-backup"].x - frames(app).canvas.x).toBe(360 + 14);
});

test("a phone lays the jobs out left to right as the desktop does, and edits nothing", async () => {
  const app = await openFlow({ width: 390, platform: "android" });
  const all = frames(app);
  const canvas = all.canvas;
  const layout = layoutFlow(jobsOf(app), FLOW_PHONE);
  // Where the phone's layout says: columns across the page, each stacked down it.
  for (const node of layout.nodes) {
    const frame = all[`job-${node.id}`];
    expect(Math.abs(frame.x - canvas.x - 14 - node.x)).toBeLessThan(0.6);
    expect(Math.abs(frame.y - canvas.y - 14 - node.y)).toBeLessThan(0.6);
    expect(frame.w).toBe(FLOW_PHONE.nodeMain);
    expect(frame.h).toBe(58);
  }
  // Dependencies run left to right; the two jobs that use the report are one above the other.
  expect(all["job-digest"].x).toBeGreaterThan(all["job-report"].x + all["job-report"].w);
  expect(all["job-brief"].x).toBeGreaterThan(all["job-digest"].x + all["job-digest"].w);
  expect(all["job-risk"].x).toBe(all["job-digest"].x);
  expect(Math.abs(all["job-risk"].y - all["job-digest"].y)).toBeGreaterThanOrEqual(58);
  // The line from the report to the digest spans the gutter between them, left to right.
  expect(Math.abs(all["line-report>digest"].x + 6 - (all["job-report"].x + all["job-report"].w))).toBeLessThan(1.5);
  // The same selection.
  await app.press("id:todo-flow-job-digest");
  expect(fadedJobs(app)).toEqual(["backup", "heartbeat", "notes", "peer", "risk", "triage"]);
  // Opening works; linking is not offered.
  expect(app.count("id:todo-flow-link-from-digest")).toBe(0);
  await app.press("label:Open Team digest");
  expect(calls(app)).toEqual(["open(digest)"]);
  // Links are named and take no presses: no picker.
  expect(app.count("label:Team digest runs each time Morning report finishes, with that result")).toBe(1);
  await app.press("id:todo-flow-link-report>digest");
  await app.wait(200);
  expect(app.count("text:Remove this link")).toBe(0);
  // The join rule is words.
  expect(app.texts()).toContain("runs when all have finished");
  expect(app.count("label:Weekly brief runs when all have finished")).toBe(0);
  await app.press("id:todo-flow-ground");
  expect(fadedJobs(app)).toEqual([]);
  // The same replay.
  await app.press("id:replay");
  expect(events(app).filter((event) => event.name.startsWith("step:")).map((event) => event.name)).toEqual(["step:0:report", "step:1:report+digest+risk", "step:2:report+digest+risk+brief"]);
  expect(fadedJobs(app)).toEqual(["backup", "heartbeat", "notes", "peer", "triage"]);
  expect(app.count("label:Risk summary, failed, Failed: the model timed out")).toBe(1);
  expect(calls(app)).toEqual(["open(digest)"]);
});

const overlap = (a: FlowBox, b: FlowBox) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

for (const item of [
  { name: "a desktop", width: 1280, platform: "linux" as const, metrics: FLOW_DESKTOP },
  { name: "a phone", width: 390, platform: "android" as const, metrics: FLOW_PHONE },
]) {
  test(`forty jobs and sixty links lie where the layout says on ${item.name}, none over another`, async () => {
    const app = await openFlow({ width: item.width, platform: item.platform });
    const started = Date.now();
    await app.press("id:set-forty");
    await app.waitFor("id:todo-flow-job-j39");
    const jobs = jobsOf(app);
    expect(jobs).toHaveLength(40);
    expect(jobs.reduce((sum, job) => sum + job.uses.length, 0)).toBe(60);
    const layout = layoutFlow(jobs, item.metrics);
    await app.waitUntil(() => {
      const all = frames(app);
      return layout.nodes.every((node) => all[`job-${node.id}`]) && layout.links.every((link) => all[`line-${link.key}`] && all[`link-${link.key}`]);
    });
    // The whole picture, entrance and draw-in over, well inside what a person waits for.
    expect(Date.now() - started).toBeLessThan(8000);
    const all = frames(app);
    const canvas = all.canvas;
    const near = (a: number, b: number) => Math.abs(a - b) < 0.6;
    // The canvas holds the whole picture, larger than the window both ways: it scrolls.
    expect(near(canvas.w, layout.width + 28)).toBe(true);
    expect(canvas.h).toBeGreaterThanOrEqual(layout.height + 28);
    expect(canvas.w).toBeGreaterThan(item.width);
    expect(canvas.h).toBeGreaterThan(900);
    const boxes: (Frame & { id: string })[] = [];
    for (const node of layout.nodes) {
      const frame = all[`job-${node.id}`];
      expect(near(frame.x - canvas.x - 14, node.x)).toBe(true);
      expect(near(frame.y - canvas.y - 14, node.y)).toBe(true);
      expect(near(frame.w, node.w)).toBe(true);
      expect(near(frame.h, node.h)).toBe(true);
      boxes.push({ ...frame, id: node.id });
    }
    boxes.forEach((a, i) => {
      for (const b of boxes.slice(i + 1)) {
        if (overlap(a, b)) throw new Error(`${a.id} lies over ${b.id}`);
      }
    });
    for (const link of layout.links) {
      // Each link's drawing is its route's box; its picker's target is clear of every job.
      const drawn = all[`line-${link.key}`];
      expect(near(drawn.x - canvas.x - 14, link.box.x)).toBe(true);
      expect(near(drawn.y - canvas.y - 14, link.box.y)).toBe(true);
      expect(near(drawn.w, link.box.w)).toBe(true);
      expect(near(drawn.h, link.box.h)).toBe(true);
      const target = all[`link-${link.key}`];
      expect(near(target.x - canvas.x - 14, link.hit.x)).toBe(true);
      expect(near(target.y - canvas.y - 14, link.hit.y)).toBe(true);
      for (const box of boxes) {
        if (overlap(target, box)) throw new Error(`${link.key}: its target lies over ${box.id}`);
      }
    }
    // It still works at that size: a selection fades the jobs off its line.
    await app.press("id:todo-flow-job-j20");
    expect(shown(app, "j20")).toBe(1);
    expect(jobs.filter((job) => shown(app, job.id) < 1).length).toBeGreaterThan(10);
  });
}

test("a link that skips a column is drawn round the jobs in between", async () => {
  const app = await openFlow();
  await app.press("id:set-skip");
  await app.waitFor("id:todo-flow-job-c");
  const layout = layoutFlow(jobsOf(app));
  await app.waitUntil(() => layout.links.every((link) => frames(app)[`line-${link.key}`]));
  const all = frames(app);
  // Alpha's link to Gamma crosses Beta's column: its drawing spans it, between Beta and Delta.
  const skip = all["line-a>c"];
  expect(skip.x).toBeLessThan(all["job-b"].x);
  expect(skip.x + skip.w).toBeGreaterThan(all["job-b"].x + 228);
  const link = layout.links.find((item) => item.key === "a>c");
  const canvas = all.canvas;
  for (const [x, y] of link?.points ?? []) {
    for (const id of ["b", "d"]) {
      const box = all[`job-${id}`];
      const px = x + canvas.x + 14;
      const py = y + canvas.y + 14;
      expect(px > box.x && px < box.x + box.w && py > box.y - 8 && py < box.y + box.h + 8).toBe(false);
    }
  }
  expect(all["job-d"].y - all["job-b"].y).toBeGreaterThanOrEqual(92);
});
