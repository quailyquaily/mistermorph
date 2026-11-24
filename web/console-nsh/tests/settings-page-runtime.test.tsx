// Settings › Runtime: the agent's overview, its channels with the tasks running in each, and Poke.
import { expect, test } from "nsh/test";
import { localEndpoint, openConsole } from "./harness";
import {
  databaseLines,
  modelDetailRows,
  parseModelDetails,
  entryTasksText,
  formatCount,
  parseDatabaseMetrics,
  runningTaskCount,
  runningTasksText,
} from "../pages/settings/RuntimePanel";
import type { DatabaseMetric } from "../pages/settings/RuntimePanel";

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
  // The technical details are open, with nothing to unfold.
  expect(app.shows("id:runtime-technical >> text:inst-1")).toBe(true);
  expect(app.count("id:runtime-technical-toggle")).toBe(0);
});

test("the model card shows what the agent reports of its model, and only that", async () => {
  const llm = {
    provider: "openai",
    model: "gpt-5.2",
    profile: "fast",
    endpoint_host: "api.openai.com",
    context_window_tokens: 400000,
    reasoning_effort: "high",
    candidates: [
      { profile: "fast", model: "gpt-5.2", weight: 3 },
      { profile: "cheap", model: "gpt-5-mini", weight: 1 },
    ],
    fallbacks: [{ profile: "backup", provider: "anthropic", model: "claude-sonnet-5-5" }],
  };
  const { app } = await openConsole({ location: "/e/default/settings/runtime", api: { "GET /proxy:/overview": { body: { ...OVERVIEW, llm } } } });
  await app.waitFor("id:runtime-model >> text:api.openai.com");
  for (const text of ["fast", "400K tokens", "high", "fast (gpt-5.2) 75%, cheap (gpt-5-mini) 25%", "backup (claude-sonnet-5-5)"]) {
    expect(app.shows(`id:runtime-model >> text:${text}`)).toBe(true);
  }
  for (const label of ["Profile", "Endpoint", "Context window", "Reasoning effort", "Split", "Fallbacks"]) {
    expect(app.shows(`id:runtime-model >> text:${label}`)).toBe(true);
  }
});

test("model details: an earlier agent's provider and model alone add no lines", () => {
  expect(modelDetailRows(null)).toEqual([]);
  expect(modelDetailRows(parseModelDetails({ provider: "openai", model: "gpt-5.2" }))).toEqual([]);
  // Malformed parts are left out; one candidate is not a split; fallbacks keep their order.
  const details = parseModelDetails({
    profile: 3,
    context_window_tokens: -1,
    candidates: [{ profile: "only", weight: 1 }, { profile: "", model: "", weight: 2 }, "x"],
    fallbacks: [{ profile: "b" }, { model: "c-model" }, { profile: "d", model: "d" }, null],
  });
  expect(details.profile).toBe("");
  expect(details.contextWindowTokens).toBe(null);
  expect(modelDetailRows(details).map((row) => `${row.key}=${row.value}`)).toEqual(["fallbacks=b → c-model → d"]);
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

test("each entry shows the tasks running in it, nothing when none run; an uncounted one says it is unknown, never 0", async () => {
  const { app } = await openConsole({ location: "/e/default/settings/runtime", api: { "GET /proxy:/overview": { body: COUNTED } } });
  await app.waitFor("id:runtime-entry-console");
  // The Console and the chat command need no configuring: they are there in the Console's runtime.
  expect(tasksLine(app, "console")).toBe("2 tasks running");
  expect(tasksLine(app, "cli")).toBe(null);
  expect(tasksLine(app, "telegram")).toBe("1 task running");
  expect(tasksLine(app, "x")).toBe(null);
  // Slack runs, but its count was not taken: unknown, not nothing.
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
  expect(tasksLine(app, "console")).toBe(null);
  // A Console task and a CLI task start.
  running = { console: 1, cli: 1, telegram: 0 };
  await app.clock!.runFor(60000);
  await app.waitUntil(() => tasksLine(app, "console") === "1 task running");
  expect(tasksLine(app, "cli")).toBe("1 task running");
  expect(tasksLine(app, "telegram")).toBe(null);
  // They finish; Telegram starts three.
  running = { console: 0, cli: 0, telegram: 3 };
  await app.clock!.runFor(60000);
  await app.waitUntil(() => tasksLine(app, "telegram") === "3 tasks running");
  expect(tasksLine(app, "console")).toBe(null);
  expect(tasksLine(app, "cli")).toBe(null);
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
  // Under an entry, none running is said by saying nothing.
  expect(entryTasksText(0)).toBe("");
  expect(entryTasksText(2)).toBe("2 tasks running");
  expect(entryTasksText(null)).toBe("Running tasks unknown");
});

test("the unconfigured channels are listed under their own head, with nothing to unfold", async () => {
  const { app } = await openConsole({ location: "/e/default/settings/runtime", api: { "GET /proxy:/overview": { body: COUNTED } } });
  await app.waitFor("id:runtime-unconfigured-list");
  expect(app.shows("id:runtime-unconfigured >> text:NOT CONFIGURED") || app.shows("id:runtime-unconfigured >> text:Not configured")).toBe(true);
  for (const name of ["LINE", "Lark", "Mixin", "WeChat", "WhatsApp", "Bluesky"]) {
    expect(app.shows(`id:runtime-unconfigured-list >> text:${name}`)).toBe(true);
  }
  // The configured channels keep their lines and status above it.
  expect(app.shows("id:runtime-entry-x >> text:Needs a new login")).toBe(true);
  expect(app.shows("id:runtime-unconfigured-list >> text:Telegram")).toBe(false);
});

const DATABASES = [
  {
    name: "agent",
    file: "agent.db",
    status: "ok",
    size_bytes: 3 * 1024 * 1024,
    tables: [
      { name: "contacts", rows: 1 },
      { name: "jobs", rows: 0 },
      { name: "topic_contexts", rows: null },
    ],
  },
  { name: "journal", file: "journal.db", status: "ok", size_bytes: 0, tables: [{ name: "journal_events", rows: 1234567 }] },
  { name: "memory", file: "memory.db", status: "missing", size_bytes: null, tables: [{ name: "memories", rows: null }] },
  { name: "usage", file: "usage.db", status: "unavailable", size_bytes: null, tables: [{ name: "llm_requests", rows: null }] },
];

function overviewWithDatabases(databases: unknown) {
  return { ...OVERVIEW, runtime: { ...OVERVIEW.runtime, databases } };
}

test("Runtime metrics list the databases: each file once with its records and size, no tables", async () => {
  const { app } = await openConsole({
    location: "/e/default/settings/runtime",
    api: { "GET /proxy:/overview": { body: overviewWithDatabases(DATABASES) } },
  });
  await app.waitFor("id:runtime-database-rows");
  /** The line of `file`: its name and `value`. */
  const line = (file: string, value: string) => {
    expect(app.shows(`id:runtime-db-${file} >> text:${file}`)).toBe(true);
    expect(app.shows(`id:runtime-db-${file} >> text:${value}`)).toBe(true);
  };
  expect(app.shows("id:runtime-databases >> text:DATABASES") || app.shows("id:runtime-databases >> text:Databases")).toBe(true);
  expect(app.count("id:runtime-database-rows >> text:agent.db")).toBe(1);
  line("agent.db", "3.00 MiB");
  line("journal.db", "0 B");
  // The records are not shown beside the sizes: pressing a figure turns the column over to them.
  expect(app.shows("id:runtime-database-rows >> text:records")).toBe(false);
  await app.press("id:runtime-db-journal.db-figure");
  // Its tables' rows added up; agent.db has one table uncounted, so its sum is a floor.
  await app.waitFor("id:runtime-db-agent.db >> text:1+ records");
  // Ten thousand and up is compact in the column; the exact count is what a screen reader hears.
  line("journal.db", "1.23M records");
  expect(app.count("label:journal.db size: 0 B, 1,234,567 records")).toBe(1);
  expect(app.shows("id:runtime-database-rows >> text:MiB")).toBe(false);
  // A database not created yet keeps saying so.
  line("memory.db", "Not created yet");
  // Pressed again, back to the sizes.
  await app.press("id:runtime-db-agent.db-figure");
  await app.waitFor("id:runtime-db-agent.db >> text:3.00 MiB");
  expect(app.shows("id:runtime-database-rows >> text:records")).toBe(false);
  // A database not created yet and one that cannot be read say so in words.
  line("memory.db", "Not created yet");
  line("usage.db", "Unavailable");
  // The tables the overview sends are not shown.
  for (const table of ["contacts", "jobs", "topic_contexts", "journal_events", "memories", "llm_requests"]) {
    expect(app.shows(`id:runtime-database-rows >> text:${table}`)).toBe(false);
  }
  expect(app.count("label:agent.db size: 3.00 MiB, 1+ records")).toBe(1);
  // A database not created yet has no records to tell; one that cannot be read either.
  expect(app.shows("id:runtime-db-memory.db >> text:records")).toBe(false);
  expect(app.shows("id:runtime-db-usage.db >> text:records")).toBe(false);
  expect(app.count("id:runtime-databases-unreported")).toBe(0);
  // The process metrics are still there.
  expect(app.shows("id:runtime-metrics >> text:Goroutines")).toBe(true);
});

test("an agent that reports no database metrics says so, and the rest of the panel stays", async () => {
  // An agent of an earlier build: no `databases` at all.
  const { app } = await openConsole({ location: "/e/default/settings/runtime", api: { "GET /proxy:/overview": { body: OVERVIEW } } });
  await app.waitFor("id:runtime-databases-unreported");
  expect(app.shows("This agent does not report database metrics.")).toBe(true);
  expect(app.count("id:runtime-database-rows")).toBe(0);
  expect(app.shows("id:runtime-metrics >> text:Goroutines")).toBe(true);
  expect(app.shows("Healthy")).toBe(true);
});

test("malformed database metrics do not break the panel", async () => {
  const { app } = await openConsole({
    location: "/e/default/settings/runtime",
    api: {
      "GET /proxy:/overview": {
        body: overviewWithDatabases([null, "agent.db", { status: "ok" }, { file: "agent.db", status: "odd", size_bytes: "big", tables: "none" }]),
      },
    },
  });
  await app.waitFor("id:runtime-database-rows");
  expect(app.shows("id:runtime-database-rows >> text:agent.db")).toBe(true);
  expect(app.shows("id:runtime-database-rows >> text:Unavailable")).toBe(true);
  expect(app.shows("Healthy")).toBe(true);
});

test("database metrics: unknown is never zero, and not reported is not empty", () => {
  expect(parseDatabaseMetrics(undefined)).toBe(null);
  expect(parseDatabaseMetrics({})).toBe(null);
  expect(parseDatabaseMetrics([])).toEqual([]);
  expect(parseDatabaseMetrics(DATABASES)).toEqual([
    // contacts 1 + jobs 0, topic_contexts uncounted: a floor of 1.
    { file: "agent.db", status: "ok", sizeBytes: 3 * 1024 * 1024, records: 1, recordsPartial: true },
    { file: "journal.db", status: "ok", sizeBytes: 0, records: 1234567, recordsPartial: false },
    // A missing database has neither size nor records, whatever it lists.
    { file: "memory.db", status: "missing", sizeBytes: null, records: null, recordsPartial: false },
    // No table could be counted: unknown, never 0.
    { file: "usage.db", status: "unavailable", sizeBytes: null, records: null, recordsPartial: false },
  ]);
  // Only whole, non-negative numbers are sizes and counts; a table without a name is not one.
  expect(
    parseDatabaseMetrics([
      { file: "a.db", status: "ok", size_bytes: -1, tables: [{ name: "t", rows: 1.5 }, { name: "u", rows: "3" }, { rows: 2 }] },
      { file: "b.db", status: "missing", size_bytes: 10, tables: [] },
      { file: "c.db", status: "ok", size_bytes: 1.5, tables: [{ name: "t", rows: 0 }] },
      { file: "d.db", status: "ok", size_bytes: 4, tables: "none" },
    ]),
  ).toEqual([
    { file: "a.db", status: "ok", sizeBytes: null, records: null, recordsPartial: false },
    { file: "b.db", status: "missing", sizeBytes: null, records: null, recordsPartial: false },
    { file: "c.db", status: "ok", sizeBytes: null, records: 0, recordsPartial: false },
    { file: "d.db", status: "ok", sizeBytes: 4, records: null, recordsPartial: false },
  ]);
  const db = (over: Partial<DatabaseMetric>): DatabaseMetric => ({ file: "x.db", status: "ok", sizeBytes: 0, records: null, recordsPartial: false, ...over });
  // A database that is there but unreadable keeps its size and its records.
  expect(databaseLines([db({ file: "usage.db", status: "unavailable", sizeBytes: 2048, records: 1 })])).toEqual([
    { file: "usage.db", value: "2.00 KiB", state: false, records: "1 record", recordsExact: "1 record", label: "usage.db size" },
  ]);
  expect(databaseLines([db({ records: 0 }), db({ records: 4210, recordsPartial: true }), db({ records: null })]).map((line) => line.records)).toEqual([
    "0 records",
    "4,210+ records",
    "",
  ]);
  expect(databaseLines([db({ sizeBytes: null })]).map((line) => line.value)).toEqual(["Unavailable"]);
  expect(databaseLines([db({ records: 9999 }), db({ records: 1234567 })]).map((line) => [line.records, line.recordsExact])).toEqual([
    ["9,999 records", "9,999 records"],
    ["1.23M records", "1,234,567 records"],
  ]);
  // A missing one is its state alone.
  expect(databaseLines([db({ file: "m.db", status: "missing", sizeBytes: null })])).toEqual([
    { file: "m.db", value: "Not created yet", state: true, records: "", recordsExact: "", label: "m.db" },
  ]);
  expect([0, 7, 999, 1000, 12345, 1234567].map(formatCount)).toEqual(["0", "7", "999", "1,000", "12,345", "1,234,567"]);
});
