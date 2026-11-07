import { expect, test } from "nsh/test";
import { openConsole } from "./harness";

const event = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    event_id: "evt_one",
    run_id: "run_one",
    ts: "2026-09-21T08:00:00Z",
    step: 1,
    action_type: "ToolCallPre",
    tool_name: "url_fetch",
    decision: "allow",
    risk_level: "low",
    action_summary_redacted: "GET https://example.com/report",
    ...extra,
  });

const files = {
  default_file: "guard_audit.jsonl",
  items: [
    { name: "guard_audit.jsonl" },
    { name: "guard_audit.deny.jsonl" },
    { name: "guard_audit.jsonl.20260901T080000Z" },
  ],
};

test("audit lists the file's events by run, opens one in the side pane, and filters the page", async () => {
  const { app, calls } = await openConsole({
    location: "/e/default/audit",
    api: {
      "GET /proxy:/audit/files": { body: files },
      "GET /proxy:/audit/logs": (request) => {
        const query = new URLSearchParams(request.uri!.split("?")[1]);
        if (query.get("file") === "guard_audit.deny.jsonl") {
          return { body: { exists: true, items: [event({ event_id: "evt_deny", tool_name: "bash", decision: "deny", risk_level: "high" })] } };
        }
        if (query.get("cursor") === "c2") {
          return { body: { exists: true, items: [event({ event_id: "evt_old", tool_name: "read_file" })], has_next: false } };
        }
        return {
          body: {
            exists: true,
            has_next: true,
            next_cursor: "c2",
            items: [
              event(),
              event({ event_id: "evt_two", run_id: "run_two", tool_name: "bash", decision: "require_approval", approval_status: "pending", reasons: ["bash_requires_approval"] }),
              "plain text line",
            ],
          },
        };
      },
    },
  });
  await app.waitFor("id:audit-page");
  await app.waitFor("All events");
  await app.waitFor("url_fetch");
  await app.waitFor("run_two");
  await app.waitFor("Running bash requires manual approval first.");
  await app.waitFor("Awaiting approval");

  // Opening an event shows its details and raw JSON; pressing it again closes the pane.
  await app.press("label:url_fetch");
  await app.waitFor("id:audit-pane");
  await app.waitFor("evt_one");
  await app.waitFor("id:audit-pane-json");
  await app.press("id:raw-json-copy");
  await app.waitUntil(() => (app.clipboard() ?? "").includes('"event_id": "evt_one"'));
  await app.press("id:audit-pane-close");
  await app.waitUntil(() => !app.shows("id:audit-pane"));

  // Filtering keeps the matching events of the page.
  await app.type("id:audit-filter", "bash");
  await app.waitUntil(() => !app.shows("label:url_fetch"));
  await app.waitFor("1 of 3 on this page");
  await app.clear("id:audit-filter");
  await app.type("id:audit-filter", "nothing matches");
  await app.waitFor("No matches on this page");
  await app.press("role:button[Clear filter]");
  await app.waitFor("label:url_fetch");

  // Older pages go by cursor, and Latest comes back to the first.
  await app.press("id:audit-older");
  await app.waitFor("read_file");
  await app.waitFor("Page 2");
  await app.press("id:audit-latest");
  await app.waitFor("Page 1");
  await app.waitFor("label:url_fetch");

  // Another file lists its own events.
  await app.press("id:audit-file-guard_audit.deny.jsonl");
  await app.waitFor("label:bash");
  await app.waitUntil(() => calls.some((call) => call.uri?.includes("file=guard_audit.deny.jsonl")));

  // Archives fold under their heading.
  expect(app.shows("id:audit-file-guard_audit.jsonl.20260901T080000Z")).toBe(false);
  await app.press("id:audit-archives");
  await app.waitFor("id:audit-file-guard_audit.jsonl.20260901T080000Z");
});

test("a failing file list shows the error, and a missing file says so", async () => {
  const { app } = await openConsole({
    location: "/e/default/audit",
    api: {
      "GET /proxy:/audit/files": { status: 500, body: { error: "audit store unavailable" } },
    },
  });
  await app.waitFor("audit store unavailable");

  const second = await openConsole({
    location: "/e/default/audit",
    api: {
      "GET /proxy:/audit/files": { body: { default_file: "guard_audit.jsonl", items: [{ name: "guard_audit.jsonl" }] } },
      "GET /proxy:/audit/logs": { body: { exists: false, items: [] } },
    },
  });
  await second.app.waitFor("Audit log file not found");
});

test("tasks list a page of tasks; opening one fetches its JSON, and a failure shows in the pane", async () => {
  const { app } = await openConsole({
    location: "/e/default/audit",
    api: {
      "GET /proxy:/audit/files": { body: files },
      "GET /proxy:/audit/logs": { body: { exists: true, items: [event()] } },
      "GET /proxy:/tasks": {
        body: {
          items: [
            { id: "task_one", task: "Summarize the repo", status: "done", created_at: "2026-11-06T08:00:00Z", model: "gpt-5.2" },
            { id: "task_two", task: "Broken task", status: "failed", created_at: "2026-11-06T09:00:00Z" },
          ],
          next_cursor: "",
        },
      },
      "GET /proxy:/tasks/task_one": { body: { id: "task_one", result: { final: "ok" } } },
      "GET /proxy:/tasks/task_two": { status: 500, body: { error: "task store offline" } },
    },
  });
  await app.waitFor("label:url_fetch");
  await app.press("id:audit-tasks");
  await app.waitFor("Summarize the repo");
  await app.waitFor("2 on this page");
  await app.press("label:Summarize the repo");
  await app.waitFor("id:audit-pane-json");
  await app.waitFor("gpt-5.2");
  await app.press("label:Broken task");
  await app.waitFor("task store offline");
});

test("an empty task feed offers to open Chat", async () => {
  const { app } = await openConsole({
    location: "/e/default/audit",
    api: {
      "GET /proxy:/audit/files": { body: files },
      "GET /proxy:/audit/logs": { body: { exists: true, items: [] } },
      "GET /proxy:/tasks": { body: { items: [] } },
    },
  });
  await app.waitFor("No audit records on this page. Refresh after the next agent run.");
  await app.press("id:audit-tasks");
  await app.waitFor("No tasks yet");
  await app.press("role:button[Open Chat]");
  await app.waitFor("id:nav-chat");
});
