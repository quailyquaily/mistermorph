import { expect, test } from "nsh/test";
import { openConsole } from "./harness";

const line = (msg: string, level = "INFO", extra: Record<string, unknown> = {}) =>
  JSON.stringify({ time: "2026-11-07T08:00:00.123Z", level, msg, ...extra });

const latest = {
  file: "/state/logs/morph.jsonl",
  mod_time: "2026-11-07T08:00:01Z",
  size_bytes: 2048,
  has_next: true,
  next_cursor: "older-1",
  items: [
    line("task_started", "INFO", { task_id: "t-1" }),
    line("tool_failed", "ERROR", { tool: "bash", error: "exit 1" }),
    line("slow_model", "WARNING", { ms: 9000 }),
    "plain subprocess output",
  ],
};

test("logs tail the latest lines, filter them, open one, page back and export", async () => {
  const saved: any[] = [];
  const { app, calls } = await openConsole({
    location: "/e/default/logs",
    host: { "morph.file.save": (request: any) => (saved.push(request), "saved") },
    api: {
      "GET /proxy:/logs/latest": (request) =>
        request.uri!.includes("cursor=older-1")
          ? { body: { file: latest.file, has_next: false, items: [line("boot_done", "DEBUG")] } }
          : { body: latest },
    },
  });
  await app.waitFor("id:logs-page");
  await app.waitFor("task_started");
  await app.waitFor("tool_failed");
  await app.waitFor("plain subprocess output");
  await app.waitFor("4 / 4 lines");
  await app.waitFor("Pause following");

  // Search narrows to the matching lines and stops following.
  await app.type("id:logs-query", "bash");
  await app.waitFor("1 / 4 lines");
  await app.waitFor("Resume following");
  await app.press("id:logs-clear");
  await app.waitFor("4 / 4 lines");

  // A line opens to its fields; "Only this event" filters by its event; raw shows the JSON.
  await app.press("label:tool_failed");
  await app.waitFor("exit 1");
  await app.press("role:button[View raw log]");
  await app.waitFor("Hide raw log");
  await app.press("role:button[Only this event]");
  await app.waitFor("1 / 4 lines");
  await app.press("id:logs-clear");

  // Older lines come before the loaded ones.
  await app.press("id:logs-older");
  await app.waitFor("boot_done");
  await app.waitFor("5 / 5 lines");
  expect(calls.some((call) => call.uri?.includes("cursor=older-1"))).toBe(true);

  // A no-match filter says so and offers to clear.
  await app.type("id:logs-query", "nothing like this");
  await app.waitFor("No matching logs");
  await app.press("id:logs-clear");

  // Export saves the lines shown.
  await app.press("id:logs-export");
  await app.waitUntil(() => saved.length === 1);
  expect(saved[0].text).toContain("tool_failed");
  expect(saved[0].text).toContain("plain subprocess output");
  expect(String(saved[0].name)).toMatch(/^morph-.*\.log$/);

  // Another line count asks again.
  await app.press("id:logs-limit-100");
  await app.waitUntil(() => calls.some((call) => call.uri?.includes("limit=100")));
});

test("an agent without logs says so, and a failing request shows its error", async () => {
  const { app } = await openConsole({
    location: "/e/default/logs",
    api: { "GET /proxy:/logs/latest": { status: 404, body: { error: "not found" } } },
  });
  await app.waitFor("Current endpoint does not support log viewing");

  const second = await openConsole({
    location: "/e/default/logs",
    api: { "GET /proxy:/logs/latest": { status: 500, body: { error: "log reader crashed" } } },
  });
  await second.app.waitFor("log reader crashed");
});

test("an empty log says there are no logs yet", async () => {
  const { app } = await openConsole({
    location: "/e/default/logs",
    api: { "GET /proxy:/logs/latest": { body: { file: "", items: [] } } },
  });
  await app.waitFor("No logs yet");
  expect(app.enabled("id:logs-export")).toBe(false);
});

test("following tails new lines; paused, it says newer logs came and Latest shows them", async () => {
  let items = [line("first_line")];
  const { app } = await openConsole({
    location: "/e/default/logs",
    api: { "GET /proxy:/logs/latest": () => ({ body: { file: "/state/logs/morph.jsonl", size_bytes: items.length, items } }) },
  });
  await app.waitFor("first_line");
  items = [...items, line("second_line")];
  await app.waitFor("second_line", { timeout: 6000 });

  await app.press("id:logs-follow"); // pause
  await app.waitFor("Resume following");
  items = [...items, line("third_line")];
  await app.waitFor("Logs have been updated", { timeout: 6000 });
  expect(app.shows("third_line")).toBe(false);
  await app.press("role:button[Latest]");
  await app.waitFor("third_line");
  await app.waitFor("Pause following");
});
