// Settings › Runtime: the agent's overview, its channels with the tasks running in each, and Poke.
import { expect, test } from "nsh/test";
import { localEndpoint, openConsole } from "./harness";
import { RUNTIME_FOLD_TOGGLE_CLASS, runningTaskCount, runningTasksText } from "../pages/settings/RuntimePanel";

const OVERVIEW = {
  version: "1.2.3",
  started_at: "2026-11-07T10:00:00Z",
  uptime_sec: 3725,
  health: "ok",
  mode: "console",
  agent_name: "Morph",
  poke_enabled: true,
  awareness_running: false,
  instance_id: "inst-1",
  llm: { provider: "openai", model: "gpt-5.2" },
  channel: { telegram_configured: true, telegram_running: true, x_configured: true, x_running: true, x_status: "reauth_needed" },
  runtime: { go_version: "go1.25", goroutines: 42, heap_alloc_bytes: 2048, heap_sys_bytes: 4096, heap_objects: 7, gc_cycles: 3 },
};

test("the runtime panel shows health, model, channels and metrics", async () => {
  const { app } = await openConsole({ location: "/e/default/settings/runtime", api: { "GET /proxy:/overview": { body: OVERVIEW } } });
  await app.waitFor("id:runtime-panel");
  await app.waitFor("Healthy");
  expect(app.shows("1h 2m")).toBe(true);
  expect(app.shows("gpt-5.2")).toBe(true);
  expect(app.shows("42")).toBe(true);
  expect(app.shows("id:runtime-channels >> text:Telegram")).toBe(true);
  // X's session needs a new login.
  expect(app.shows("Needs a new login")).toBe(true);
  // The technical details are folded.
  expect(app.shows("inst-1")).toBe(false);
  await app.press("id:runtime-technical-toggle");
  await app.waitFor("inst-1");
});

test("a failed overview says so", async () => {
  const { app } = await openConsole({
    location: "/e/default/settings/runtime",
    api: { "GET /proxy:/overview": { status: 502, body: { error: "agent unreachable" } } },
  });
  await app.waitFor("id:runtime-error");
  await app.waitFor("agent unreachable");
  expect(app.shows("id:runtime-poke")).toBe(false);
});

test("Poke sends the message; a 400 shows in the dialog", async () => {
  const bodies: string[] = [];
  let reject = true;
  const { app } = await openConsole({
    location: "/e/default/settings/runtime",
    api: {
      "GET /proxy:/overview": { body: OVERVIEW },
      "POST /proxy:/poke": (request) => {
        bodies.push(String(request.body || ""));
        if (reject) {
          reject = false;
          return { status: 400, body: { error: "awareness is busy" } };
        }
        return { body: { poked_at: "2026-11-07T11:00:00Z" } };
      },
    },
  });
  await app.waitFor("id:runtime-poke");
  await app.press("id:runtime-poke");
  await app.waitFor("id:runtime-poke-dialog");
  expect(app.enabled("id:runtime-poke-submit")).toBe(false);
  await app.type("id:runtime-poke-body", "check the inbox");
  await app.press("id:runtime-poke-submit");
  await app.waitFor("awareness is busy");
  await app.press("id:runtime-poke-submit");
  await app.waitFor("id:runtime-poke-dialog", { state: "gone" });
  expect(bodies).toEqual(["check the inbox", "check the inbox"]);
});

const COUNTED = {
  ...OVERVIEW,
  channel: { ...OVERVIEW.channel, discord_configured: true, discord_running: false, slack_configured: true, slack_running: true },
  running_tasks: { console: 2, cli: 0, telegram: 1, x: 0 },
};

/** The running tasks' line of an entry, or null when it has none. */
function tasksLine(app: Awaited<ReturnType<typeof openConsole>>["app"], id: string): string | null {
  for (const text of ["No tasks running", "1 task running", "Running tasks unknown"]) {
    if (app.shows(`id:runtime-entry-${id} >> text:${text}`)) return text;
  }
  for (let n = 2; n < 50; n++) if (app.shows(`id:runtime-entry-${id} >> text:${n} tasks running`)) return `${n} tasks running`;
  return null;
}

test("each entry shows the tasks running in it; an uncounted one says it is unknown, never 0", async () => {
  const { app } = await openConsole({ location: "/e/default/settings/runtime", api: { "GET /proxy:/overview": { body: COUNTED } } });
  await app.waitFor("id:runtime-entry-console");
  // The Console and the chat command need no configuring: they are there in the Console's runtime.
  expect(tasksLine(app, "console")).toBe("2 tasks running");
  expect(tasksLine(app, "cli")).toBe("No tasks running");
  expect(tasksLine(app, "telegram")).toBe("1 task running");
  expect(tasksLine(app, "x")).toBe("No tasks running");
  // Slack runs, but its count was not taken: unknown, not "No tasks running".
  expect(tasksLine(app, "slack")).toBe("Running tasks unknown");
  // Discord does not run: no tasks line, its status says so.
  expect(tasksLine(app, "discord")).toBe(null);
  expect(app.shows("id:runtime-entry-discord >> text:Not running")).toBe(true);
  // The channels' status stays beside them.
  expect(app.shows("id:runtime-entry-x >> text:Needs a new login")).toBe(true);
  // Entries in order: Console, CLI, then the configured channels.
  const texts = app.texts();
  expect(texts.indexOf("Console", texts.indexOf("CHANNELS"))).toBeLessThan(texts.indexOf("CLI"));
  expect(texts.indexOf("CLI")).toBeLessThan(texts.indexOf("Telegram"));
});

test("an agent that does not count its tasks leaves every count unknown", async () => {
  // OVERVIEW has no running_tasks, as an older agent answers.
  const { app } = await openConsole({ location: "/e/default/settings/runtime", api: { "GET /proxy:/overview": { body: OVERVIEW } } });
  await app.waitFor("id:runtime-entry-console");
  expect(tasksLine(app, "console")).toBe("Running tasks unknown");
  expect(tasksLine(app, "cli")).toBe("Running tasks unknown");
  expect(tasksLine(app, "telegram")).toBe("Running tasks unknown");
  expect(app.shows("text:No tasks running")).toBe(false);
});

test("a channel's own runtime shows its count, without Console or CLI lines", async () => {
  const { app } = await openConsole({
    location: "/e/default/settings/runtime",
    endpoints: [localEndpoint({ mode: "telegram", url: "http://127.0.0.1:8787" })],
    api: {
      "GET /proxy:/overview": {
        body: { ...OVERVIEW, mode: "telegram", channel: { telegram_configured: true, telegram_running: true, running: "telegram" }, running_tasks: { telegram: 4 } },
      },
    },
  });
  await app.waitFor("id:runtime-entry-telegram");
  expect(tasksLine(app, "telegram")).toBe("4 tasks running");
  expect(app.shows("id:runtime-entry-console")).toBe(false);
  expect(app.shows("id:runtime-entry-cli")).toBe(false);
});

test("the counts follow tasks starting and finishing with the minute's refresh", async () => {
  let running = { console: 0, cli: 0, telegram: 0 };
  const { app } = await openConsole({
    location: "/e/default/settings/runtime",
    clock: true,
    api: { "GET /proxy:/overview": () => ({ body: { ...OVERVIEW, running_tasks: running } }) },
  });
  await app.waitFor("id:runtime-entry-console");
  expect(tasksLine(app, "console")).toBe("No tasks running");
  // A Console task and a CLI task start.
  running = { console: 1, cli: 1, telegram: 0 };
  await app.clock!.runFor(60000);
  await app.waitUntil(() => tasksLine(app, "console") === "1 task running");
  expect(tasksLine(app, "cli")).toBe("1 task running");
  expect(tasksLine(app, "telegram")).toBe("No tasks running");
  // They finish; Telegram starts three.
  running = { console: 0, cli: 0, telegram: 3 };
  await app.clock!.runFor(60000);
  await app.waitUntil(() => tasksLine(app, "telegram") === "3 tasks running");
  expect(tasksLine(app, "console")).toBe("No tasks running");
  expect(tasksLine(app, "cli")).toBe("No tasks running");
});

test("running counts: only whole counts the agent took are known", () => {
  expect(runningTaskCount({ console: 0 }, "console")).toBe(0);
  expect(runningTaskCount({ console: 3 }, "console")).toBe(3);
  expect(runningTaskCount({ console: 3 }, "cli")).toBe(null);
  expect(runningTaskCount(null, "console")).toBe(null);
  expect(runningTaskCount({ console: -1 }, "console")).toBe(null);
  expect(runningTaskCount({ console: 1.5 }, "console")).toBe(null);
  expect(runningTaskCount({ console: "2" }, "console")).toBe(null);
  expect(runningTasksText(null)).toBe("Running tasks unknown");
  expect(runningTasksText(0)).toBe("No tasks running");
  expect(runningTasksText(1)).toBe("1 task running");
  expect(runningTasksText(7)).toBe("7 tasks running");
});

test("the unconfigured channels fold opens and closes, its keyboard focus shown", async () => {
  const { app } = await openConsole({ location: "/e/default/settings/runtime", api: { "GET /proxy:/overview": { body: COUNTED } } });
  await app.waitFor("id:runtime-unconfigured");
  expect(app.shows("id:runtime-unconfigured-list")).toBe(false);
  // The fold's line is a pressable view, so a Tab stop that Enter and Space press (headless runs
  // move no keyboard focus; checked in Chrome). nsh web draws no outline: its class shows the focus.
  expect(RUNTIME_FOLD_TOGGLE_CLASS).toContain("focus:bg-hover");
  expect(RUNTIME_FOLD_TOGGLE_CLASS).toContain("focus:ring-2");
  await app.press("id:runtime-unconfigured");
  await app.waitFor("id:runtime-unconfigured-list");
  for (const name of ["LINE", "Lark", "Mixin", "WeChat", "WhatsApp", "Bluesky"]) {
    expect(app.shows(`id:runtime-unconfigured-list >> text:${name}`)).toBe(true);
  }
  // The configured channels keep their lines and status above it.
  expect(app.shows("id:runtime-entry-x >> text:Needs a new login")).toBe(true);
  await app.press("id:runtime-unconfigured");
  await app.waitFor("id:runtime-unconfigured-list", { state: "gone" });
});
