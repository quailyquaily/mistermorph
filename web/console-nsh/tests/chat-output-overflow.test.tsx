// Progress and coder output in the detail panel: what is drawn without wrapping (a tool's name, a
// coder's processes) stays inside the panel at every width and scrolls sideways once it is longer
// than its room; what fits is no scroller. Parameters, nested calls, output, notes and errors wrap
// (they are never in such a line: tests/chat-activity-params.test.tsx), and the empty states are as
// they were.
import { expect, open, test, type App } from "nsh/test";

type Line = { line: number; testID: string; viewport: number; content: number; offset: number; scrolls: boolean };
type Report = { panel: number; lines: Line[] };

// `text:/…/` selectors match part of a text (the output is one text of several lines).
const PROSE = "/This sentence of prose keeps wrapping inside the panel/";

function report(app: App): Report {
  return JSON.parse(app.texts().find((text) => text.startsWith('{"panel"')) ?? '{"panel":0,"lines":[]}') as Report;
}

function linesOf(app: App, testID: string) {
  return report(app).lines.filter((line) => line.testID === testID);
}

async function settle(app: App, ids: string[]) {
  await app.waitUntil(() => {
    const all = report(app);
    return all.panel > 0 && ids.every((id) => all.lines.some((line) => line.testID === id && line.viewport > 0 && line.content > 0));
  });
  await app.wait(50);
}

async function openPanel(width: number, kind: "activity" | "worker") {
  const app = await open("./fixtures/output-overflow-app.tsx", { width, height: 800, platform: "linux", locale: "en-US" });
  if (kind === "worker") await app.press("id:show-worker");
  await settle(app, kind === "worker" ? ["chat-worker-process"] : ["chat-activity-title"]);
  return app;
}

/** Every line stays inside the panel, and scrolls exactly when its run is longer than its room. */
function expectContained(app: App) {
  const all = report(app);
  expect(all.lines.length).toBeGreaterThan(0);
  for (const line of all.lines) {
    expect(line.viewport).toBeLessThan(all.panel);
    expect(line.scrolls).toBe(line.content > line.viewport + 0.5);
    // A line is never wider than its run: short runs take their own width.
    expect(line.viewport).toBeLessThan(line.content + 0.5);
  }
}

// How many titles scroll: on a phone the long tool name; from 760pt on none.
const SCROLLING = [
  { width: 360, title: 1 },
  { width: 760, title: 0 },
  { width: 1400, title: 0 },
];

for (const item of SCROLLING) {
  test(`at ${item.width}pt the progress's unwrapped runs stay in the panel and long ones scroll`, async () => {
    const app = await openPanel(item.width, "activity");
    expectContained(app);
    const scrolling = (id: string) => linesOf(app, id).filter((line) => line.scrolls).length;
    expect(linesOf(app, "chat-activity-title").length).toBe(6);
    expect(scrolling("chat-activity-title")).toBe(item.title);
    // Parameters and nested calls are in no such line.
    expect(linesOf(app, "chat-activity-param").length).toBe(0);
    expect(linesOf(app, "chat-activity-call").length).toBe(0);
  });
}

for (const width of [360, 760, 1400]) {
  test(`at ${width}pt a coder's processes stay in the panel`, async () => {
    const app = await openPanel(width, "worker");
    expectContained(app);
    const processes = linesOf(app, "chat-worker-process");
    expect(processes.length).toBe(2);
    // "bash PID 99" always fits.
    expect(processes.filter((line) => !line.scrolls).length).toBeGreaterThan(0);
  });
}

test("a long run scrolls sideways in its own line, and back", async () => {
  const app = await openPanel(360, "activity");
  const title = () => linesOf(app, "chat-activity-title").find((line) => line.scrolls)!;
  expect(title().offset).toBe(0);
  await app.scroll("id:chat-activity-title >> nth=2", 120);
  await app.waitUntil(() => title().offset > 0);
  expect(title().offset).toBeLessThan(title().content - title().viewport + 0.5);
  await app.scroll("id:chat-activity-title >> nth=2", -400);
  await app.waitUntil(() => title().offset === 0);
});

test("a line becomes a scroller as the window narrows and goes back to a row as it widens", async () => {
  const app = await openPanel(1400, "worker");
  const long = () => linesOf(app, "chat-worker-process").reduce((a, b) => (a.content > b.content ? a : b));
  expect(long().scrolls).toBe(false);
  await app.setViewport(360, 800);
  await app.waitUntil(() => long().scrolls);
  expectContained(app);
  await app.setViewport(1400, 800);
  await app.waitUntil(() => !long().scrolls);
  expectContained(app);
});

test("output, notes and errors keep wrapping: none of them is in a sideways line", async () => {
  for (const kind of ["activity", "worker"] as const) {
    const app = await openPanel(360, kind);
    const panel = kind === "activity" ? "id:chat-detail-activity" : "id:chat-detail-worker";
    expect(app.shows(`${panel} >> text:${PROSE}`)).toBe(true);
    expect(app.shows(`${panel} >> text:${kind === "activity" ? "/^error: \\/home/" : "/^panic: \\/home/"}`)).toBe(true);
    for (const id of ["chat-activity-title", "chat-activity-param", "chat-activity-call", "chat-worker-process"]) {
      expect(app.shows(`id:${id} >> text:${PROSE}`)).toBe(false);
      expect(app.shows(`id:${id} >> text:/^error: /`)).toBe(false);
      expect(app.shows(`id:${id} >> text:/^panic: /`)).toBe(false);
      expect(app.shows(`id:${id} >> text:/No such file/`)).toBe(false);
      expect(app.shows(`id:${id} >> text:/READY   STATUS/`)).toBe(false);
    }
  }
});

test("in the workbench (one scroll area) the runs wrap at the panel's edge: none scrolls sideways", async () => {
  for (const kind of ["activity", "worker"] as const) {
    const app = await openPanel(360, kind);
    await app.press("id:show-dark");
    // The runs are there, whole, but none is a sideways line any more.
    await app.waitFor(kind === "activity" ? "id:chat-activity-call" : "id:chat-worker-process");
    await app.wait(100);
    expect(report(app).lines.length).toBe(0);
    if (kind === "activity") expect(app.shows("id:chat-activity-param >> text:/never\\/ends\\/file_name.go/")).toBe(true);
  }
});

test("the empty states show no lines", async () => {
  const app = await openPanel(360, "activity");
  await app.press("id:show-missing-worker");
  await app.waitFor("id:chat-detail-empty");
  expect(app.shows("text:No output yet.") || app.shows("id:chat-detail-empty")).toBe(true);
  expect(app.count("id:chat-worker-process")).toBe(0);
  await app.press("id:show-empty");
  await app.press("id:show-activity");
  await app.waitFor("id:chat-detail-empty");
  expect(app.count("id:chat-activity-param")).toBe(0);
  expect(app.count("id:chat-activity-title")).toBe(0);
  expect(report(app).lines.length).toBe(0);
});
